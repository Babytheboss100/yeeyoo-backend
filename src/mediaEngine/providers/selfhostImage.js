import { assertProviderAdapter, mapProviderStatus, normalizeProviderError, PROVIDER_ERROR_CODES, ProviderAdapterError } from '../contracts/provider.js'
import { createWorkerRequest, validateHandlerOutput, validateWorkerRequest, Z_IMAGE_TURBO } from '../contracts/workerApi.js'

const MAX_CONTROL_PLANE_RESPONSE_BYTES = 12 * 1024 * 1024
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function validateBaseUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new TypeError('Image worker URL is invalid')
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new TypeError('Image worker URL must use HTTPS outside loopback')
  return url.toString().replace(/\/$/, '')
}

function validateProviderId(value) {
  if (typeof value !== 'string' || !PROVIDER_ID_RE.test(value)) throw new ProviderAdapterError('INVALID_INPUT', 'Provider job id is invalid')
  return value
}

function httpError(status) {
  if (status === 401 || status === 403) return new ProviderAdapterError('AUTH_ERROR', 'Image worker authentication failed')
  if (status === 404) return new ProviderAdapterError('RESULT_EXPIRED', 'Image worker result is unavailable')
  if (status === 409) return new ProviderAdapterError('IDEMPOTENCY_CONFLICT', 'Image worker rejected a reused idempotency key')
  if (status === 429) return new ProviderAdapterError('RATE_LIMITED', 'Image worker is busy', { retryable: true })
  if (status >= 400 && status < 500) return new ProviderAdapterError('INVALID_INPUT', 'Image worker rejected the request')
  return new ProviderAdapterError('PROVIDER_TEMPORARY', 'Image worker is temporarily unavailable', { retryable: true })
}

async function parseBoundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > MAX_CONTROL_PLANE_RESPONSE_BYTES) throw new ProviderAdapterError('RESULT_INVALID', 'Image worker response is too large')
  let text
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_CONTROL_PLANE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new ProviderAdapterError('RESULT_INVALID', 'Image worker response is too large')
      }
      chunks.push(Buffer.from(value))
    }
    text = Buffer.concat(chunks, bytes).toString('utf8')
  } else {
    text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_PLANE_RESPONSE_BYTES) throw new ProviderAdapterError('RESULT_INVALID', 'Image worker response is too large')
  }
  try { return JSON.parse(text) } catch { throw new ProviderAdapterError('RESULT_INVALID', 'Image worker returned invalid JSON') }
}

export function createSelfhostImageProvider({ baseUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000, estimatedUsd = null, maxTrackedRequests = 1_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
  if (typeof serviceToken !== 'string' || serviceToken.length < 16 || serviceToken.length > 512 || serviceToken.trim() !== serviceToken || /[\u0000-\u001f\u007f]/.test(serviceToken)) throw new TypeError('A valid image worker service token is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError('Image worker timeout is invalid')
  if (!Number.isSafeInteger(maxTrackedRequests) || maxTrackedRequests < 1 || maxTrackedRequests > 100_000) throw new TypeError('Image worker request tracking limit is invalid')
  const workerBaseUrl = validateBaseUrl(baseUrl)
  const submittedRequests = new Map()

  function rememberRequest(providerJobId, workerRequest) {
    submittedRequests.delete(providerJobId)
    submittedRequests.set(providerJobId, workerRequest)
    while (submittedRequests.size > maxTrackedRequests) submittedRequests.delete(submittedRequests.keys().next().value)
  }

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${workerBaseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${serviceToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      if (!response.ok) throw httpError(response.status)
      return await parseBoundedJson(response)
    } catch (error) {
      throw normalizeProviderError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  const adapter = {
    name: 'selfhost-image',
    capabilities() {
      return { operations: ['image.generate'], models: [Z_IMAGE_TURBO], aspects: ['1:1', '7:9', '9:7', '4:7', '7:4'], tier: 'standard' }
    },
    estimateCost() {
      return estimatedUsd == null
        ? { estimatedUsd: null, currency: 'USD', basis: 'hypothesis', billable: true }
        : { estimatedUsd: String(estimatedUsd), currency: 'USD', basis: 'benchmark', billable: true }
    },
    async submit(input) {
      const workerRequest = input?.schemaVersion ? validateWorkerRequest(input) : createWorkerRequest(input)
      const response = await request('/run', { method: 'POST', body: { input: workerRequest } })
      const providerJobId = validateProviderId(response?.id)
      mapProviderStatus(response.status)
      rememberRequest(providerJobId, workerRequest)
      return { providerJobId }
    },
    async getStatus(providerJobId, expectedRequest) {
      const id = validateProviderId(providerJobId)
      const response = await request(`/status/${encodeURIComponent(id)}`)
      if (response?.id !== id) throw new ProviderAdapterError('RESULT_INVALID', 'Image worker returned a mismatched job id')
      const state = mapProviderStatus(response.status)
      if (state === 'succeeded') {
        const boundRequest = expectedRequest || submittedRequests.get(id)
        if (!boundRequest) throw new ProviderAdapterError('RESULT_INVALID', 'Expected request context is required to validate a completed result')
        const result = validateHandlerOutput(response.output, { expectedRequest: boundRequest })
        return { providerJobId: id, state, result, providerMetrics: providerMetrics(response) }
      }
      if (['failed', 'timed_out', 'expired'].includes(state)) {
        return { providerJobId: id, state, error: safeWorkerError(response.error, state), providerMetrics: providerMetrics(response) }
      }
      return { providerJobId: id, state, providerMetrics: providerMetrics(response) }
    },
    async cancel(providerJobId) {
      const id = validateProviderId(providerJobId)
      const response = await request(`/cancel/${encodeURIComponent(id)}`, { method: 'POST' })
      if (response?.id !== id) throw new ProviderAdapterError('RESULT_INVALID', 'Image worker returned a mismatched job id')
      return { providerJobId: id, state: mapProviderStatus(response.status) }
    },
    normalizeResult(payload, expectedRequest) {
      return validateHandlerOutput(payload, { expectedRequest })
    },
  }
  return Object.freeze(assertProviderAdapter(adapter))
}

function providerMetrics(response) {
  const metrics = {
    queueMs: nonNegativeOrNull(response.delayTime),
    executionMs: nonNegativeOrNull(response.executionTime),
    costBasis: 'provider_observed_time',
  }
  const gpuSeconds = nonNegativeOrNull(response?.usage?.gpu_seconds)
  if (gpuSeconds !== null) metrics.gpuSeconds = gpuSeconds
  if (typeof response?.usage?.billable === 'boolean') metrics.billable = response.usage.billable
  return metrics
}

function nonNegativeOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function safeErrorMessage(state) {
  if (state === 'timed_out') return 'Image worker timed out'
  if (state === 'expired') return 'Image worker result expired'
  return 'Image worker failed'
}

function safeWorkerError(error, state) {
  const retryable = typeof error?.retryable === 'boolean' ? error.retryable : state === 'timed_out'
  const workerMap = {
    JOB_CANCELLED: 'CANCELLED',
    WORKER_TIMEOUT: 'PROVIDER_TIMEOUT',
    INFERENCE_FAILED: retryable ? 'PROVIDER_TEMPORARY' : 'PROVIDER_PERMANENT',
    INTERNAL_ERROR: 'PROVIDER_PERMANENT',
    RESULT_EXPIRED: 'RESULT_EXPIRED',
  }
  const fallback = state === 'timed_out' ? 'PROVIDER_TIMEOUT' : state === 'expired' ? 'RESULT_EXPIRED' : retryable ? 'PROVIDER_TEMPORARY' : 'PROVIDER_PERMANENT'
  const code = PROVIDER_ERROR_CODES.includes(error?.code) ? error.code : workerMap[error?.code] || fallback
  return { code, message: safeErrorMessage(state), retryable }
}
