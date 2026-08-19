import crypto from 'node:crypto'
import { assertProviderAdapter, PROVIDER_ERROR_CODES, PROVIDER_JOB_STATES, ProviderAdapterError } from '../contracts/provider.js'
import { canonicalStringify, createWorkerRequest, IMAGE_OPERATION, Z_IMAGE_TURBO, Z_IMAGE_TURBO_STEPS } from '../contracts/workerApi.js'
import { COMPOSER_VIDEO_MODEL, createVideoRenderRequest, VIDEO_RENDER_OPERATION } from '../providers/composerVideo.js'
import { assertStorageAdapter } from '../storage/contract.js'
import { MediaJobError, toSafeMediaJobError } from './errors.js'

const IMAGE_CREATE_FIELDS = new Set(['projectId', 'operation', 'model', 'prompt', 'negativePrompt', 'width', 'height', 'seed', 'steps'])
const VIDEO_CREATE_FIELDS = new Set(['projectId', 'operation', 'project'])
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const FINGERPRINT_JOB_REF = '00000000-0000-4000-8000-000000000000'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function cleanIdempotencyKey(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MediaJobError('IDEMPOTENCY_KEY_REQUIRED', 'Valid Idempotency-Key is required', { status: 400 })
  }
  return value
}

function normalizeBaseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new MediaJobError('INVALID_MEDIA_JOB_REQUEST', 'Media job body must be an object', { status: 400 })
  }
  if (typeof input.projectId !== 'string' || !input.projectId.trim() || input.projectId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.projectId)) {
    throw new MediaJobError('PROJECT_REQUIRED', 'projectId is required', { status: 400 })
  }
  const operation = input.operation ?? IMAGE_OPERATION
  if (![IMAGE_OPERATION, VIDEO_RENDER_OPERATION].includes(operation)) throw new MediaJobError('UNSUPPORTED_MEDIA_OPERATION', 'Media operation is unsupported', { status: 400 })
  const fields = operation === IMAGE_OPERATION ? IMAGE_CREATE_FIELDS : VIDEO_CREATE_FIELDS
  if (Object.keys(input).some(key => !fields.has(key))) throw new MediaJobError('INVALID_MEDIA_JOB_REQUEST', 'Media job body contains unsupported fields', { status: 400 })
  return Object.freeze({ projectId: input.projectId.trim(), operation })
}

function normalizeImageInput(input, base) {
  try {
    const normalized = createWorkerRequest({
      jobRef: FINGERPRINT_JOB_REF,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      width: input.width ?? 1024,
      height: input.height ?? 1024,
      seed: input.seed,
      model: input.model ?? Z_IMAGE_TURBO,
      steps: input.steps ?? Z_IMAGE_TURBO_STEPS,
    })
    const { jobRef: _jobRef, requestHash: _requestHash, ...workerInput } = normalized
    return Object.freeze({ ...base, workerInput })
  } catch (error) {
    throw toSafeMediaJobError(error)
  }
}

function validateResolvedVideoInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      !value.project || typeof value.project !== 'object' || !value.assetBindings || typeof value.assetBindings !== 'object') {
    throw new MediaJobError('VIDEO_ASSET_RESOLUTION_FAILED', 'Video assets could not be resolved', { status: 400 })
  }
  return value
}

function safeProviderFailure(error, fallbackCode = 'PROVIDER_PERMANENT') {
  const code = PROVIDER_ERROR_CODES.includes(error?.code) ? error.code : fallbackCode
  const messages = {
    AUTH_ERROR: 'Media worker authentication failed',
    MODEL_UNAVAILABLE: 'Media model is unavailable',
    CONTENT_REJECTED: 'Media request was rejected by content policy',
    INVALID_INPUT: 'Media worker rejected the request',
    RATE_LIMITED: 'Media worker is busy',
    PROVIDER_TIMEOUT: 'Media worker timed out',
    PROVIDER_TEMPORARY: 'Media worker is temporarily unavailable',
    PROVIDER_PERMANENT: 'Media worker failed',
    BILLING_REJECTED: 'Image generation budget was rejected',
    RESULT_INVALID: 'Media worker returned an invalid result',
    RESULT_EXPIRED: 'Media worker result expired',
    IDEMPOTENCY_CONFLICT: 'Media worker rejected a reused idempotency key',
    CANCELLED: 'Image job was cancelled',
  }
  return Object.freeze({ code, message: messages[code] || messages.PROVIDER_PERMANENT, retryable: Boolean(error?.retryable) })
}

function validateProviderResponse(value, expectedProviderJobId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || value.providerJobId !== expectedProviderJobId || !PROVIDER_JOB_STATES.includes(value.state)) {
    throw new ProviderAdapterError('RESULT_INVALID', 'Media worker returned a malformed status response')
  }
  return value
}

function normalizeCostEstimate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Provider cost estimate is invalid')
  const estimatedUsd = value.estimatedUsd
  if (estimatedUsd !== null && (typeof estimatedUsd !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(estimatedUsd) || estimatedUsd.length > 40)) throw new TypeError('Provider cost estimate is invalid')
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || typeof value.basis !== 'string' || !value.basis || value.basis.length > 100 || typeof value.billable !== 'boolean') throw new TypeError('Provider cost estimate is invalid')
  return Object.freeze({ estimatedUsd, currency: value.currency, basis: value.basis, billable: value.billable })
}

function normalizeProviderMetrics(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const numberOrNull = item => item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0) ? item : null
  if (typeof value.costBasis !== 'string' || !value.costBasis || value.costBasis.length > 100) return null
  const metrics = { queueMs: numberOrNull(value.queueMs), executionMs: numberOrNull(value.executionMs), costBasis: value.costBasis }
  if (typeof value.gpuSeconds === 'number' && Number.isFinite(value.gpuSeconds) && value.gpuSeconds >= 0) metrics.gpuSeconds = value.gpuSeconds
  if (typeof value.billable === 'boolean') metrics.billable = value.billable
  return Object.freeze(metrics)
}

function publicJob(job) {
  if (!job) return null
  return Object.freeze({
    id: job.id,
    projectId: job.projectId,
    operation: job.operation,
    status: job.status,
    cancelRequested: Boolean(job.cancelRequested),
    reconciliation: Object.freeze({
      paused: job.reconciliationState === 'paused',
      nextAttemptAt: job.nextReconcileAt || null,
    }),
    provider: job.provider,
    model: job.model,
    artifacts: structuredClone(job.artifacts || []),
    usage: structuredClone(job.usage || {}),
    error: job.error ? structuredClone(job.error) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
  })
}

async function persistResult(storage, result) {
  if (result?.artifact) {
    const expected = result.artifact
    const stored = await storage.stat(expected.objectRef)
    if (stored.mimeType !== 'video/mp4' || stored.sha256 !== expected.sha256 || stored.sizeBytes !== expected.sizeBytes) {
      throw new MediaJobError('RESULT_INVALID', 'Stored video result failed integrity verification', { status: 502 })
    }
    return Object.freeze({
      ...stored,
      composerProjectSha256: result.composerProjectSha256,
      genome: structuredClone(result.genome),
      render: structuredClone(result.render),
    })
  }
  if (result?.output?.transport !== 'inline_base64') {
    throw new MediaJobError('RESULT_INVALID', 'Media storage received an unsupported worker output', { status: 502 })
  }
  const bytes = Buffer.from(result.output.dataBase64, 'base64')
  return storage.put({ bytes, mimeType: result.output.mimeType, expectedSha256: result.output.sha256 })
}

function terminalPatch(status, now) {
  return { status, updatedAt: now, finishedAt: now, consecutiveControlPlaneErrors: 0, reconciliationState: 'active', nextReconcileAt: null }
}

export function createMediaJobService({ store, provider, providers, storage, resolveVideoInput, deferredOperations = [], clock = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), maxControlPlaneErrors = 5, reconciliationBackoffMs = 1_000 } = {}) {
  if (!store || typeof store.create !== 'function' || typeof store.getOwned !== 'function' || typeof store.compareAndSet !== 'function' || typeof store.attachProviderJobId !== 'function') throw new TypeError('Media job store is invalid')
  if (!Number.isSafeInteger(maxControlPlaneErrors) || maxControlPlaneErrors < 1 || maxControlPlaneErrors > 100) throw new TypeError('maxControlPlaneErrors is invalid')
  if (!Number.isSafeInteger(reconciliationBackoffMs) || reconciliationBackoffMs < 0 || reconciliationBackoffMs > 60_000) throw new TypeError('reconciliationBackoffMs is invalid')
  assertStorageAdapter(storage)
  const providerMap = new Map()
  if (providers != null) {
    const entries = providers instanceof Map ? [...providers.entries()] : Object.entries(providers)
    for (const [operation, adapter] of entries) providerMap.set(operation, assertProviderAdapter(adapter))
  } else if (provider) providerMap.set(IMAGE_OPERATION, assertProviderAdapter(provider))
  if (!providerMap.has(IMAGE_OPERATION)) throw new TypeError('Image provider is required')
  for (const [operation, adapter] of providerMap) {
    if (!adapter.capabilities()?.operations?.includes(operation)) throw new TypeError(`Provider does not support ${operation}`)
  }
  const deferred = new Set(deferredOperations)
  for (const operation of deferred) if (!providerMap.has(operation)) throw new TypeError(`Deferred provider does not support ${operation}`)
  const jobLocks = new Map()

  function providerFor(operation) {
    const selected = providerMap.get(operation)
    if (!selected) throw new MediaJobError(operation === VIDEO_RENDER_OPERATION ? 'VIDEO_RENDER_SETUP_REQUIRED' : 'UNSUPPORTED_MEDIA_OPERATION', 'Media operation is not configured', { status: 503 })
    return selected
  }

  async function withJobLock(id, action) {
    const previous = jobLocks.get(id) || Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    jobLocks.set(id, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (jobLocks.get(id) === tail) jobLocks.delete(id)
    }
  }

  function normalizeJobId(id) {
    return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null
  }

  async function setFailure(job, error) {
    const now = clock()
    return store.compareAndSet({
      id: job.id,
      userId: job.userId,
      expectedVersion: job.version,
      mutate: current => TERMINAL.has(current.status) ? current : { ...current, ...terminalPatch('failed', now), error: safeProviderFailure(error) },
    })
  }

  async function recordControlPlaneError(job, error, patch = {}) {
    const now = clock()
    const consecutiveErrors = Number(job.consecutiveControlPlaneErrors || 0) + 1
    const paused = consecutiveErrors >= maxControlPlaneErrors
    const delayMs = Math.min(60_000, reconciliationBackoffMs * (2 ** Math.min(consecutiveErrors - 1, 10)))
    const nextReconcileAt = paused ? null : new Date(Date.parse(now) + delayMs).toISOString()
    return store.compareAndSet({
      id: job.id,
      userId: job.userId,
      expectedVersion: job.version,
      mutate: current => TERMINAL.has(current.status) ? current : {
        ...current,
        ...patch,
        error: safeProviderFailure(error, 'PROVIDER_TEMPORARY'),
        updatedAt: now,
        consecutiveControlPlaneErrors: consecutiveErrors,
        reconciliationState: paused ? 'paused' : 'active',
        nextReconcileAt,
        usage: { ...current.usage, controlPlaneErrors: Number(current.usage?.controlPlaneErrors || 0) + 1 },
      },
    })
  }

  function canReconcile(job) {
    if (job.reconciliationState === 'paused') return false
    return !job.nextReconcileAt || Date.parse(clock()) >= Date.parse(job.nextReconcileAt)
  }

  async function incrementUsage(job, field) {
    return store.compareAndSet({
      id: job.id,
      userId: job.userId,
      expectedVersion: job.version,
      mutate: current => TERMINAL.has(current.status) ? current : {
        ...current,
        usage: { ...current.usage, [field]: Number(current.usage?.[field] || 0) + 1 },
      },
    })
  }

  async function markCancelled(job) {
    const now = clock()
    return store.compareAndSet({
      id: job.id,
      userId: job.userId,
      expectedVersion: job.version,
      mutate: current => TERMINAL.has(current.status) ? current : {
        ...current,
        ...terminalPatch('cancelled', now),
        cancelRequested: true,
        error: safeProviderFailure({ code: 'CANCELLED' }),
      },
    })
  }

  async function markCancelRequested(job) {
    const now = clock()
    return store.compareAndSet({
      id: job.id,
      userId: job.userId,
      expectedVersion: job.version,
      mutate: current => TERMINAL.has(current.status) || current.cancelRequested ? current : {
        ...current,
        cancelRequested: true,
        updatedAt: now,
      },
    })
  }

  async function recordRejectedCancellation(job, error) {
    const now = clock()
    return store.compareAndSet({
      id: job.id,
      userId: job.userId,
      expectedVersion: job.version,
      mutate: current => TERMINAL.has(current.status) ? current : {
        ...current,
        cancelRequested: false,
        error: safeProviderFailure(error),
        updatedAt: now,
        consecutiveControlPlaneErrors: 0,
        reconciliationState: 'active',
        nextReconcileAt: null,
        usage: { ...current.usage, controlPlaneErrors: Number(current.usage?.controlPlaneErrors || 0) + 1 },
      },
    })
  }

  async function reconcileSubmission(snapshot) {
    if (snapshot.providerJobId || TERMINAL.has(snapshot.status)) return snapshot
    snapshot = await incrementUsage(snapshot, 'attempts')
    const selectedProvider = providerFor(snapshot.operation)
    try {
      const submitted = await selectedProvider.submit(snapshot.workerRequest)
      return await store.attachProviderJobId({ id: snapshot.id, userId: snapshot.userId, providerJobId: submitted.providerJobId })
    } catch (error) {
      if (error?.retryable) return recordControlPlaneError(snapshot, error, { submissionState: 'unknown' })
      return setFailure(snapshot, error)
    }
  }

  async function observeProvider(snapshot) {
    snapshot = await incrementUsage(snapshot, 'statusChecks')
    const selectedProvider = providerFor(snapshot.operation)
    let providerStatus
    try {
      providerStatus = validateProviderResponse(await selectedProvider.getStatus(snapshot.providerJobId, snapshot.workerRequest), snapshot.providerJobId)
    } catch (error) {
      return error?.retryable ? recordControlPlaneError(snapshot, error) : setFailure(snapshot, error)
    }
    const providerMetrics = normalizeProviderMetrics(providerStatus.providerMetrics)
    if (providerStatus.state === 'queued' || providerStatus.state === 'processing') {
      const updated = await store.compareAndSet({
        id: snapshot.id,
        userId: snapshot.userId,
        expectedVersion: snapshot.version,
        mutate: current => TERMINAL.has(current.status) ? current : {
          ...current,
          status: providerStatus.state,
          updatedAt: clock(),
          error: null,
          consecutiveControlPlaneErrors: 0,
          reconciliationState: 'active',
          nextReconcileAt: null,
          usage: { ...current.usage, providerMetrics },
        },
      })
      return updated
    }
    if (providerStatus.state === 'succeeded') {
      try {
        const validatedResult = await selectedProvider.normalizeResult(providerStatus.result, snapshot.workerRequest)
        const artifact = await persistResult(storage, validatedResult)
        const now = clock()
        return await store.compareAndSet({
          id: snapshot.id,
          userId: snapshot.userId,
          expectedVersion: snapshot.version,
          mutate: current => TERMINAL.has(current.status) ? current : {
            ...current,
            ...terminalPatch('succeeded', now),
            artifacts: [artifact],
            error: null,
            usage: {
              ...current.usage,
              gpuSeconds: validatedResult?.timings?.gpuActiveSeconds ?? null,
              providerMetrics,
            },
          },
        })
      } catch (error) {
        return setFailure(snapshot, error)
      }
    }
    if (providerStatus.state === 'cancelled') return markCancelled(snapshot)
    return setFailure(snapshot, providerStatus.error || {
      code: providerStatus.state === 'timed_out' ? 'PROVIDER_TIMEOUT' : providerStatus.state === 'expired' ? 'RESULT_EXPIRED' : 'PROVIDER_PERMANENT',
      retryable: providerStatus.state === 'timed_out',
    })
  }

  async function reconcileCancel(snapshot) {
    if (TERMINAL.has(snapshot.status) || !snapshot.providerJobId) return snapshot
    snapshot = await incrementUsage(snapshot, 'cancelAttempts')
    const selectedProvider = providerFor(snapshot.operation)
    let result
    try {
      result = validateProviderResponse(await selectedProvider.cancel(snapshot.providerJobId), snapshot.providerJobId)
    } catch (error) {
      if (error?.code === 'RESULT_INVALID') return recordControlPlaneError(snapshot, { code: 'PROVIDER_TEMPORARY', retryable: true }, { cancelRequested: true })
      return error?.retryable
        ? recordControlPlaneError(snapshot, error, { cancelRequested: true })
        : recordRejectedCancellation(snapshot, error)
    }
    if (result.state === 'cancelled') return markCancelled(snapshot)
    if (result.state === 'succeeded') return observeProvider(snapshot)
    if (result.state === 'expired') return setFailure(snapshot, { code: 'RESULT_EXPIRED' })
    if (result.state === 'failed' || result.state === 'timed_out') return observeProvider(snapshot)
    const pendingState = ['queued', 'processing'].includes(result?.state) ? result.state : snapshot.status
    return recordControlPlaneError(
      snapshot,
      { code: 'PROVIDER_TEMPORARY', retryable: true },
      { cancelRequested: true, status: pendingState },
    )
  }

  async function create({ userId, input, idempotencyKey }) {
    const key = cleanIdempotencyKey(idempotencyKey)
    const base = normalizeBaseInput(input)
    let normalized
    if (base.operation === IMAGE_OPERATION) normalized = normalizeImageInput(input, base)
    else {
      if (typeof resolveVideoInput !== 'function') throw new MediaJobError('VIDEO_ASSET_RESOLVER_REQUIRED', 'Video asset resolver is not configured', { status: 503 })
      const resolved = validateResolvedVideoInput(await resolveVideoInput({ userId, projectId: base.projectId, input: structuredClone(input) }))
      normalized = Object.freeze({ ...base, resolved })
    }
    const generatedId = idFactory()
    if (typeof generatedId !== 'string' || !UUID_RE.test(generatedId)) throw new TypeError('Media job idFactory must return a UUID')
    const id = generatedId.toLowerCase()
    const workerRequest = normalized.operation === IMAGE_OPERATION
      ? createWorkerRequest({ jobRef: id, ...normalized.workerInput })
      : createVideoRenderRequest({ jobRef: id, project: normalized.resolved.project, assetBindings: normalized.resolved.assetBindings, genomeHints: normalized.resolved.genomeHints || {} })
    const requestFingerprint = normalized.operation === IMAGE_OPERATION
      ? sha256(canonicalStringify({ projectId: normalized.projectId, ...normalized.workerInput }))
      : sha256(canonicalStringify({ projectId: normalized.projectId, operation: normalized.operation, requestHash: workerRequest.requestHash }))
    const selectedProvider = providerFor(normalized.operation)
    const now = clock()
    const record = {
      id,
      userId,
      projectId: normalized.projectId,
      operation: normalized.operation,
      provider: selectedProvider.name || 'provider',
      model: normalized.operation === VIDEO_RENDER_OPERATION ? COMPOSER_VIDEO_MODEL : workerRequest.model,
      status: 'queued',
      idempotencyKey: key,
      requestFingerprint,
      workerRequest,
      providerJobId: null,
      submissionState: 'submitting',
      cancelRequested: false,
      consecutiveControlPlaneErrors: 0,
      reconciliationState: 'active',
      nextReconcileAt: null,
      artifacts: [],
      usage: { estimate: normalizeCostEstimate(selectedProvider.estimateCost(workerRequest)), attempts: 1 },
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    }
    const stored = await store.create(record)
    if (!stored.created) return { job: publicJob(stored.job), created: false }
    if (deferred.has(normalized.operation)) return { job: publicJob(stored.job), created: true }
    try {
      const submitted = await selectedProvider.submit(workerRequest)
      const updated = await withJobLock(id, async () => {
        const attached = await store.attachProviderJobId({ id, userId, providerJobId: submitted.providerJobId })
        if (attached?.cancelRequested && !TERMINAL.has(attached.status)) return reconcileCancel(attached)
        return attached
      })
      return { job: publicJob(updated), created: true }
    } catch (error) {
      const updated = await withJobLock(id, async () => {
        const current = await store.getOwned({ id, userId })
        if (!current || TERMINAL.has(current.status)) return current
        return error?.retryable
          ? recordControlPlaneError(current, error, { submissionState: 'unknown' })
          : setFailure(current, error)
      })
      return { job: publicJob(updated), created: true }
    }
  }

  async function getJob({ id, userId }) {
    const normalizedId = normalizeJobId(id)
    return normalizedId ? publicJob(await store.getOwned({ id: normalizedId, userId })) : null
  }

  async function refreshUnlocked({ id, userId }) {
    let snapshot = await store.getOwned({ id, userId })
    if (!snapshot) return null
    if (TERMINAL.has(snapshot.status)) return publicJob(snapshot)
    if (deferred.has(snapshot.operation)) return publicJob(snapshot)
    if (!canReconcile(snapshot)) return publicJob(snapshot)
    if (!snapshot.providerJobId) snapshot = await reconcileSubmission(snapshot)
    if (!snapshot || TERMINAL.has(snapshot.status) || !snapshot.providerJobId) return publicJob(snapshot)
    if (snapshot.cancelRequested) return publicJob(await reconcileCancel(snapshot))
    return publicJob(await observeProvider(snapshot))
  }

  async function refresh({ id, userId }) {
    const normalizedId = normalizeJobId(id)
    return normalizedId ? withJobLock(normalizedId, () => refreshUnlocked({ id: normalizedId, userId })) : null
  }

  async function cancelUnlocked({ id, userId }) {
    let snapshot = await store.getOwned({ id, userId })
    if (!snapshot) return null
    if (TERMINAL.has(snapshot.status)) return publicJob(snapshot)
    if (deferred.has(snapshot.operation)) return publicJob(await markCancelled(snapshot))
    snapshot = await markCancelRequested(snapshot)
    if (!snapshot.providerJobId) return publicJob(snapshot)
    if (!canReconcile(snapshot)) return publicJob(snapshot)
    return publicJob(await reconcileCancel(snapshot))
  }

  async function cancel({ id, userId }) {
    const normalizedId = normalizeJobId(id)
    return normalizedId ? withJobLock(normalizedId, () => cancelUnlocked({ id: normalizedId, userId })) : null
  }

  return Object.freeze({ create, getJob, refresh, cancel })
}

export { publicJob as toPublicMediaJob }
