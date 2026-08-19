import crypto from 'node:crypto'
import { canonicalStringify } from '../contracts/workerApi.js'
import { assertProviderAdapter, ProviderAdapterError } from '../contracts/provider.js'

export const VIDEO_RENDER_OPERATION = 'video.render'
export const COMPOSER_VIDEO_MODEL = 'yeeyoo-media-composer-0.3.0'
export const VIDEO_RENDER_SCHEMA_VERSION = 'yeeyoo.media.video-render.v1'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[a-f0-9]{64}$/
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

function requirePlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ProviderAdapterError('INVALID_INPUT', `${name} is invalid`)
  return value
}

function cloneJson(value, name) {
  try {
    const json = canonicalStringify(value)
    if (Buffer.byteLength(json, 'utf8') > 2 * 1024 * 1024) throw new Error('too large')
    return JSON.parse(json)
  } catch {
    throw new ProviderAdapterError('INVALID_INPUT', `${name} is invalid`)
  }
}

export function computeVideoRenderRequestHash(value) {
  return hash(canonicalStringify(value))
}

export function createVideoRenderRequest({ jobRef, project, assetBindings = {}, genomeHints = {} } = {}) {
  if (typeof jobRef !== 'string' || !UUID_RE.test(jobRef)) throw new ProviderAdapterError('INVALID_INPUT', 'video jobRef is invalid')
  requirePlainObject(project, 'video project')
  requirePlainObject(assetBindings, 'video assetBindings')
  requirePlainObject(genomeHints, 'video genomeHints')
  const semantic = {
    schemaVersion: VIDEO_RENDER_SCHEMA_VERSION,
    operation: VIDEO_RENDER_OPERATION,
    model: COMPOSER_VIDEO_MODEL,
    project: cloneJson(project, 'video project'),
    assetBindings: cloneJson(assetBindings, 'video assetBindings'),
    genomeHints: cloneJson(genomeHints, 'video genomeHints'),
  }
  return Object.freeze({ jobRef: jobRef.toLowerCase(), ...semantic, requestHash: computeVideoRenderRequestHash(semantic) })
}

export function validateVideoRenderRequest(value) {
  requirePlainObject(value, 'video request')
  const allowed = new Set(['jobRef', 'schemaVersion', 'operation', 'model', 'project', 'assetBindings', 'genomeHints', 'requestHash'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new ProviderAdapterError('INVALID_INPUT', 'video request contains unsupported fields')
  const expected = createVideoRenderRequest(value)
  if (value.schemaVersion !== expected.schemaVersion || value.operation !== expected.operation || value.model !== expected.model || value.requestHash !== expected.requestHash) {
    throw new ProviderAdapterError('INVALID_INPUT', 'video request hash is invalid')
  }
  return expected
}

function validateStoredArtifact(value) {
  requirePlainObject(value, 'stored video artifact')
  if (typeof value.objectRef !== 'string' || !value.objectRef || value.mimeType !== 'video/mp4' ||
      !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || !SHA256_RE.test(value.sha256 || '') || typeof value.persistent !== 'boolean') {
    throw new ProviderAdapterError('RESULT_INVALID', 'composer returned an invalid stored artifact')
  }
  return Object.freeze({
    storage: typeof value.storage === 'string' ? value.storage : 'storage-adapter',
    objectRef: value.objectRef,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    persistent: value.persistent,
  })
}

async function defaultExecute(request, { signal, storage }) {
  const { executeComposerVideoRender } = await import('../composer/runtime.js')
  return executeComposerVideoRender({
    project: request.project,
    genomeHints: request.genomeHints,
    assetBindings: request.assetBindings,
    storage,
    signal,
  })
}

export function createComposerVideoProvider({
  execute = defaultExecute,
  storage,
  maxJobs = 100,
  terminalTtlMs = 15 * 60 * 1000,
  clockMs = () => Date.now(),
} = {}) {
  if (typeof execute !== 'function' || !storage) throw new TypeError('Composer video executor and storage are required')
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) throw new TypeError('Composer video maxJobs is invalid')
  if (!Number.isSafeInteger(terminalTtlMs) || terminalTtlMs < 1 || terminalTtlMs > 24 * 60 * 60 * 1000) throw new TypeError('Composer video terminalTtlMs is invalid')
  const jobs = new Map()
  const submissions = new Map()

  function purge() {
    const now = clockMs()
    for (const [id, job] of jobs) {
      if (!TERMINAL.has(job.state) || job.finishedAt == null || now - job.finishedAt < terminalTtlMs) continue
      jobs.delete(id)
      submissions.delete(job.request.jobRef)
    }
  }

  function publicStatus(job) {
    return {
      providerJobId: job.providerJobId,
      state: job.state,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      providerMetrics: { queueMs: job.startedAt == null ? null : Math.max(0, job.startedAt - job.createdAt), executionMs: job.finishedAt == null || job.startedAt == null ? null : Math.max(0, job.finishedAt - job.startedAt), costBasis: 'composer-local' },
    }
  }

  async function run(job) {
    if (job.controller.signal.aborted || job.state !== 'queued') return
    job.state = 'processing'
    job.startedAt = clockMs()
    try {
      const output = await execute(job.request, { signal: job.controller.signal, storage })
      if (job.controller.signal.aborted) {
        job.state = 'cancelled'
        job.error = { code: 'CANCELLED', retryable: false }
      } else {
        const artifact = validateStoredArtifact(output?.stored)
        job.state = 'succeeded'
        job.result = Object.freeze({
          schemaVersion: VIDEO_RENDER_SCHEMA_VERSION,
          jobRef: job.request.jobRef,
          requestHash: job.request.requestHash,
          artifact,
          genome: structuredClone(output.genome),
          composerProjectSha256: output.composerProjectSha256,
          render: structuredClone(output.render),
        })
      }
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.state = 'cancelled'
        job.error = { code: 'CANCELLED', retryable: false }
      } else {
        job.state = 'failed'
        job.error = { code: error?.code === 'INVALID_INPUT' || error?.code === 'COMPOSER_PROJECT_INVALID' ? 'INVALID_INPUT' : 'PROVIDER_PERMANENT', retryable: false }
      }
    } finally {
      job.finishedAt = clockMs()
    }
  }

  const provider = {
    name: 'composer-video',
    capabilities() { return { operations: [VIDEO_RENDER_OPERATION], models: [COMPOSER_VIDEO_MODEL], tier: 'standard', outputKinds: ['storage_ref'] } },
    estimateCost() { return { estimatedUsd: '0.000000', currency: 'USD', basis: 'composer-local', billable: false } },
    async submit(value) {
      purge()
      const request = validateVideoRenderRequest(value)
      const replay = submissions.get(request.jobRef)
      if (replay) {
        if (replay.requestHash !== request.requestHash) throw new ProviderAdapterError('IDEMPOTENCY_CONFLICT', 'Video jobRef was reused with different input')
        return { providerJobId: replay.providerJobId }
      }
      if (jobs.size >= maxJobs) throw new ProviderAdapterError('RATE_LIMITED', 'Composer video capacity is exhausted', { retryable: true })
      const providerJobId = `composer-${crypto.randomUUID()}`
      const job = { providerJobId, request, state: 'queued', result: null, error: null, controller: new AbortController(), createdAt: clockMs(), startedAt: null, finishedAt: null }
      jobs.set(providerJobId, job)
      submissions.set(request.jobRef, { providerJobId, requestHash: request.requestHash })
      queueMicrotask(() => run(job))
      return { providerJobId }
    },
    async getStatus(providerJobId, expectedRequest) {
      purge()
      const job = jobs.get(providerJobId)
      if (!job) return { providerJobId, state: 'expired', error: { code: 'RESULT_EXPIRED', retryable: false } }
      if (expectedRequest && validateVideoRenderRequest(expectedRequest).requestHash !== job.request.requestHash) throw new ProviderAdapterError('IDEMPOTENCY_CONFLICT', 'Video status request does not match submission')
      return publicStatus(job)
    },
    async cancel(providerJobId) {
      purge()
      const job = jobs.get(providerJobId)
      if (!job) return { providerJobId, state: 'expired' }
      if (!TERMINAL.has(job.state)) {
        job.controller.abort()
        job.state = 'cancelled'
        job.error = { code: 'CANCELLED', retryable: false }
        job.finishedAt = clockMs()
      }
      return publicStatus(job)
    },
    normalizeResult(value, expectedRequest) {
      requirePlainObject(value, 'composer result')
      const request = validateVideoRenderRequest(expectedRequest)
      if (value.schemaVersion !== VIDEO_RENDER_SCHEMA_VERSION || value.jobRef !== request.jobRef || value.requestHash !== request.requestHash || !SHA256_RE.test(value.composerProjectSha256 || '')) {
        throw new ProviderAdapterError('RESULT_INVALID', 'composer result is not bound to the request')
      }
      return Object.freeze({ ...structuredClone(value), artifact: validateStoredArtifact(value.artifact) })
    },
  }
  return Object.freeze(assertProviderAdapter(provider))
}
