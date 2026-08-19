import { validateVideoRenderRequest } from '../providers/composerVideo.js'
import { assertStorageAdapter } from '../storage/contract.js'

const SHA256_RE = /^[a-f0-9]{64}$/

function validatedOutput(output, request) {
  const stored = output?.stored
  if (!stored || typeof stored.objectRef !== 'string' || stored.mimeType !== 'video/mp4' || !SHA256_RE.test(stored.sha256 || '') || !Number.isSafeInteger(stored.sizeBytes) || stored.sizeBytes < 1) {
    throw Object.assign(new Error('Video executor returned an invalid artifact'), { code: 'RESULT_INVALID', retryable: false })
  }
  if (!SHA256_RE.test(output.composerProjectSha256 || '')) throw Object.assign(new Error('Video result has no composer project checksum'), { code: 'RESULT_INVALID', retryable: false })
  if (output.render?.sha256 !== stored.sha256 || output.render?.sizeBytes !== stored.sizeBytes) throw Object.assign(new Error('Video render metadata does not match its stored checksum'), { code: 'RESULT_INVALID', retryable: false })
  return Object.freeze({
    storage: stored.storage || 'storage-adapter', objectRef: stored.objectRef, mimeType: stored.mimeType,
    sha256: stored.sha256, sizeBytes: stored.sizeBytes, persistent: Boolean(stored.persistent),
    requestHash: request.requestHash, composerProjectSha256: output.composerProjectSha256,
    genome: structuredClone(output.genome), render: structuredClone(output.render),
  })
}

export function createVideoLeaseRunner({
  workerId, store, storage, resolveVideoInput, execute, leaseSeconds = 90,
  heartbeatMs = 30_000, workspace, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof workerId !== 'string' || !workerId.trim() || !store || typeof store.claim !== 'function' || typeof store.heartbeat !== 'function' || typeof store.complete !== 'function' || typeof store.fail !== 'function' || typeof store.get !== 'function') throw new TypeError('Video lease runner identity and store are required')
  assertStorageAdapter(storage)
  if (typeof resolveVideoInput !== 'function' || typeof execute !== 'function') throw new TypeError('Video resolver and executor are required')
  if (workspace && (typeof workspace.prepare !== 'function' || typeof workspace.cleanup !== 'function')) throw new TypeError('Video lease workspace is invalid')
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs >= leaseSeconds * 1000) throw new TypeError('heartbeatMs must be shorter than the lease')
  let activeController = null

  async function recoverExpiredLeases() {
    const recovered = await store.recoverExpired()
    if (workspace) {
      for (const item of recovered) if (item?.status === 'failed') await workspace.cleanup(item.id)
    }
    return recovered
  }

  async function currentState(id) {
    const current = await store.get(id)
    return current?.status === 'cancelled' ? 'cancelled' : current?.status || 'lease_lost'
  }

  return Object.freeze({
    abortActive() { activeController?.abort() },
    async recover() { return recoverExpiredLeases() },

    async runOnce() {
      await recoverExpiredLeases()
      const job = await store.claim({ workerId, leaseSeconds })
      if (!job) return null
      const controller = new AbortController()
      activeController = controller
      let heartbeatFailure = null
      let heartbeatBusy = false
      let heartbeatStopped = false
      let heartbeatPromise = Promise.resolve()
      const timer = setIntervalImpl(async () => {
        if (heartbeatStopped || heartbeatBusy || controller.signal.aborted) return
        heartbeatBusy = true
        heartbeatPromise = (async () => {
          try {
            if (!await store.heartbeat({ id: job.id, workerId, leaseSeconds })) {
              heartbeatFailure = Object.assign(new Error('Video lease was cancelled or lost'), { code: 'LEASE_LOST', retryable: true })
              controller.abort()
            }
          } catch {
            heartbeatFailure = Object.assign(new Error('Video heartbeat failed'), { code: 'HEARTBEAT_FAILED', retryable: true })
            controller.abort()
          } finally { heartbeatBusy = false }
        })()
        await heartbeatPromise
      }, heartbeatMs)
      const stopHeartbeat = async () => {
        if (!heartbeatStopped) {
          heartbeatStopped = true
          clearIntervalImpl(timer)
        }
        await heartbeatPromise
      }
      let workspaceRoot
      try {
        workspaceRoot = await workspace?.prepare(job.id)
        const request = validateVideoRenderRequest(job.input?.mediaEngine?.workerRequest)
        const resolved = await resolveVideoInput({ userId: job.userId, projectId: job.projectId, input: { project: request.project, genomeHints: request.genomeHints } })
        const output = await execute({ project: resolved.project, assetBindings: resolved.assetBindings, genomeHints: resolved.genomeHints || request.genomeHints, storage, signal: controller.signal, ...(workspaceRoot ? { workspaceRoot } : {}) })
        await stopHeartbeat()
        if (heartbeatFailure || controller.signal.aborted) return { state: await currentState(job.id), jobId: job.id }
        const metadata = await storage.stat(output?.stored?.objectRef)
        if (metadata.sha256 !== output?.stored?.sha256 || metadata.sizeBytes !== output?.stored?.sizeBytes || metadata.mimeType !== 'video/mp4') throw Object.assign(new Error('Stored video checksum changed'), { code: 'RESULT_INVALID', retryable: false })
        const artifact = validatedOutput(output, request)
        const completed = await store.complete({ id: job.id, workerId, artifacts: [artifact], usage: { requestHash: request.requestHash, billable: false } })
        return completed ? { state: 'succeeded', job: completed, artifact } : { state: await currentState(job.id), jobId: job.id }
      } catch (error) {
        await stopHeartbeat()
        if (heartbeatFailure || controller.signal.aborted) return { state: await currentState(job.id), jobId: job.id }
        const safeError = { code: typeof error?.code === 'string' ? error.code : 'VIDEO_RENDER_FAILED', retryable: error?.retryable !== false }
        const failed = await store.fail({ id: job.id, workerId, error: safeError, retryable: safeError.retryable })
        return failed ? { state: failed.status, job: failed } : { state: await currentState(job.id), jobId: job.id }
      } finally {
        await stopHeartbeat()
        try {
          if (workspaceRoot) await workspace.cleanup(job.id)
        } finally {
          if (activeController === controller) activeController = null
        }
      }
    },
  })
}
