import { MediaJobError } from './errors.js'

const clone = value => value == null ? value : structuredClone(value)
const scopeKey = ({ userId, projectId, idempotencyKey }) => JSON.stringify([userId, projectId, idempotencyKey])

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value.trim()
}

export function createInMemoryMediaJobStore({ maxJobs = 1_000, terminalTtlMs = 15 * 60 * 1000, clockMs = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100_000) throw new TypeError('Media job store maxJobs is invalid')
  if (!Number.isSafeInteger(terminalTtlMs) || terminalTtlMs < 1 || terminalTtlMs > 24 * 60 * 60 * 1000) throw new TypeError('Media job store terminalTtlMs is invalid')
  if (typeof clockMs !== 'function') throw new TypeError('Media job store clockMs is invalid')
  const jobs = new Map()
  const idempotency = new Map()

  function purgeExpiredTerminal() {
    const now = clockMs()
    for (const [id, job] of jobs) {
      const finished = Date.parse(job.finishedAt || '')
      if (!['succeeded', 'failed', 'cancelled'].includes(job.status) || !Number.isFinite(finished) || now - finished < terminalTtlMs) continue
      jobs.delete(id)
      idempotency.delete(scopeKey(job))
    }
  }

  return Object.freeze({
    kind: 'memory',

    async create(job) {
      purgeExpiredTerminal()
      const userId = requireText(job?.userId, 'userId')
      const projectId = requireText(job?.projectId, 'projectId')
      const idempotencyKey = requireText(job?.idempotencyKey, 'idempotencyKey')
      const fingerprint = requireText(job?.requestFingerprint, 'requestFingerprint', 64)
      const key = scopeKey({ userId, projectId, idempotencyKey })
      const existingId = idempotency.get(key)
      if (existingId) {
        const existing = jobs.get(existingId)
        if (!existing || existing.requestFingerprint !== fingerprint) {
          throw new MediaJobError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with different media input', { status: 409 })
        }
        return { job: clone(existing), created: false }
      }
      if (jobs.size >= maxJobs) {
        throw new MediaJobError('MEDIA_JOB_STORE_CAPACITY', 'Media job store capacity is temporarily exhausted', { status: 503, retryable: true })
      }
      if (jobs.has(job.id)) throw new MediaJobError('MEDIA_JOB_ID_CONFLICT', 'Media job identity already exists', { status: 409 })
      const stored = clone({ ...job, userId, projectId, idempotencyKey, requestFingerprint: fingerprint, version: 1 })
      jobs.set(stored.id, stored)
      idempotency.set(key, stored.id)
      return { job: clone(stored), created: true }
    },

    async getOwned({ id, userId }) {
      purgeExpiredTerminal()
      const job = jobs.get(id)
      return job && job.userId === userId ? clone(job) : null
    },

    async compareAndSet({ id, userId, expectedVersion, mutate }) {
      const current = jobs.get(id)
      if (!current || current.userId !== userId) return null
      if (current.version !== expectedVersion) return clone(current)
      const candidate = mutate(clone(current))
      if (!candidate || candidate.id !== current.id || candidate.userId !== current.userId || candidate.projectId !== current.projectId || candidate.idempotencyKey !== current.idempotencyKey) {
        throw new TypeError('Media job mutation changed immutable scope')
      }
      const stored = clone({ ...candidate, version: current.version + 1 })
      jobs.set(id, stored)
      return clone(stored)
    },

    async attachProviderJobId({ id, userId, providerJobId }) {
      const current = jobs.get(id)
      if (!current || current.userId !== userId) return null
      const normalized = requireText(providerJobId, 'providerJobId')
      if (current.providerJobId && current.providerJobId !== normalized) {
        throw new MediaJobError('PROVIDER_JOB_ID_CONFLICT', 'Media job is already bound to another provider job', { status: 409 })
      }
      if (current.providerJobId === normalized) return clone(current)
      const stored = clone({
        ...current,
        providerJobId: normalized,
        submissionState: 'submitted',
        error: null,
        consecutiveControlPlaneErrors: 0,
        reconciliationState: 'active',
        nextReconcileAt: null,
        version: current.version + 1,
      })
      jobs.set(id, stored)
      return clone(stored)
    },

    async count() {
      purgeExpiredTerminal()
      return jobs.size
    },
  })
}
