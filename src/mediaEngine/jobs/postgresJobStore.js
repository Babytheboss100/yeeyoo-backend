import { MediaJobError } from './errors.js'

const MEDIA_KINDS = Object.freeze(['image.generate', 'video.render'])
const STORE_SCHEMA_VERSION = 'yeeyoo.media.job-store.pg.v1'
const LOCAL_STATUSES = new Set(['queued', 'processing', 'succeeded', 'failed', 'cancelled'])
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const CONTROL_RE = /[\u0000-\u001f\u007f]/

const clone = value => value == null ? value : structuredClone(value)

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max || CONTROL_RE.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Media job version is invalid')
  return value
}

function iso(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} is invalid`)
  return date.toISOString()
}

function jsonValue(value, label) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { throw new TypeError(`${label} is not JSON data`) }
  if (encoded === undefined) throw new TypeError(`${label} is not JSON data`)
  return encoded
}

function objectJson(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`)
  jsonValue(value, label)
  return clone(value)
}

function arrayJson(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`)
  jsonValue(value, label)
  return clone(value)
}

function parseJson(value, label) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { throw new TypeError(`${label} contains invalid JSON`) }
}

function toDbStatus(status) {
  if (!LOCAL_STATUSES.has(status)) throw new TypeError('Media job status is invalid')
  return status === 'processing' ? 'running' : status
}

function fromDbStatus(status) {
  if (status === 'running') return 'processing'
  if (!LOCAL_STATUSES.has(status)) throw new TypeError('Persisted media job status is invalid')
  return status
}

function mediaInput(job, version) {
  if (typeof job.cancelRequested !== 'boolean') throw new TypeError('cancelRequested is invalid')
  if (!Number.isSafeInteger(job.consecutiveControlPlaneErrors) || job.consecutiveControlPlaneErrors < 0) throw new TypeError('consecutiveControlPlaneErrors is invalid')
  return {
    mediaEngine: {
      schemaVersion: STORE_SCHEMA_VERSION,
      version,
      requestFingerprint: requireText(job.requestFingerprint, 'requestFingerprint', 64),
      workerRequest: objectJson(job.workerRequest, 'workerRequest'),
      submissionState: requireText(job.submissionState, 'submissionState', 40),
      cancelRequested: job.cancelRequested,
      consecutiveControlPlaneErrors: job.consecutiveControlPlaneErrors,
      reconciliationState: requireText(job.reconciliationState, 'reconciliationState', 40),
      nextReconcileAt: job.nextReconcileAt == null ? null : iso(job.nextReconcileAt, 'nextReconcileAt'),
    },
  }
}

function metadata(row) {
  const input = parseJson(row?.input, 'ai_jobs.input')
  const media = input?.mediaEngine
  if (!media || media.schemaVersion !== STORE_SCHEMA_VERSION) throw new TypeError('Persisted media job metadata is invalid')
  requireVersion(Number(media.version))
  requireText(media.requestFingerprint, 'persisted requestFingerprint', 64)
  objectJson(media.workerRequest, 'persisted workerRequest')
  requireText(media.submissionState, 'persisted submissionState', 40)
  requireText(media.reconciliationState, 'persisted reconciliationState', 40)
  if (typeof media.cancelRequested !== 'boolean') throw new TypeError('Persisted cancelRequested is invalid')
  if (!Number.isSafeInteger(media.consecutiveControlPlaneErrors) || media.consecutiveControlPlaneErrors < 0) throw new TypeError('Persisted control-plane error count is invalid')
  if (media.nextReconcileAt != null) iso(media.nextReconcileAt, 'persisted nextReconcileAt')
  return media
}

function decode(row) {
  if (!row) return null
  const media = metadata(row)
  const artifacts = parseJson(row.artifacts, 'ai_jobs.artifacts')
  const usage = parseJson(row.usage, 'ai_jobs.usage')
  const error = parseJson(row.error, 'ai_jobs.error')
  if (!Array.isArray(artifacts)) throw new TypeError('Persisted media job artifacts are invalid')
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new TypeError('Persisted media job usage is invalid')
  if (error != null && (!error || typeof error !== 'object' || Array.isArray(error))) throw new TypeError('Persisted media job error is invalid')
  return {
    id: String(row.id).toLowerCase(),
    userId: row.user_id,
    projectId: row.project_id,
    operation: row.kind,
    provider: row.provider,
    model: row.model,
    status: fromDbStatus(row.status),
    idempotencyKey: row.idempotency_key,
    requestFingerprint: media.requestFingerprint,
    workerRequest: clone(media.workerRequest),
    providerJobId: row.provider_job_id || null,
    submissionState: media.submissionState,
    cancelRequested: Boolean(media.cancelRequested),
    consecutiveControlPlaneErrors: Number(media.consecutiveControlPlaneErrors || 0),
    reconciliationState: media.reconciliationState,
    nextReconcileAt: media.nextReconcileAt || null,
    artifacts: clone(artifacts),
    usage: clone(usage),
    error: error == null ? null : clone(error),
    createdAt: iso(row.created_at, 'created_at'),
    updatedAt: iso(row.updated_at, 'updated_at'),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at, 'finished_at'),
    version: Number(media.version),
  }
}

function normalizeRecord(job, version) {
  const status = toDbStatus(job.status)
  const normalized = {
    ...clone(job),
    id: requireText(job.id, 'id', 100).toLowerCase(),
    userId: requireText(job.userId, 'userId'),
    projectId: requireText(job.projectId, 'projectId'),
    operation: requireText(job.operation, 'operation', 80),
    provider: requireText(job.provider, 'provider', 100),
    model: job.model == null ? null : requireText(job.model, 'model', 200),
    idempotencyKey: requireText(job.idempotencyKey, 'idempotencyKey'),
    providerJobId: job.providerJobId == null ? null : requireText(job.providerJobId, 'providerJobId'),
    artifacts: arrayJson(job.artifacts || [], 'artifacts'),
    usage: objectJson(job.usage || {}, 'usage'),
    error: job.error == null ? null : objectJson(job.error, 'error'),
    createdAt: iso(job.createdAt, 'createdAt'),
    updatedAt: iso(job.updatedAt, 'updatedAt'),
    finishedAt: job.finishedAt == null ? null : iso(job.finishedAt, 'finishedAt'),
    version: requireVersion(version),
  }
  return { normalized, dbStatus: status, input: mediaInput(normalized, normalized.version) }
}

function assertImmutableScope(current, candidate) {
  if (!candidate || candidate.id !== current.id || candidate.userId !== current.userId || candidate.projectId !== current.projectId || candidate.idempotencyKey !== current.idempotencyKey || candidate.operation !== current.operation) {
    throw new TypeError('Media job mutation changed immutable scope')
  }
}

function queryFunction({ db, query } = {}) {
  if (typeof query === 'function') return query
  if (db && typeof db.query === 'function') return db.query.bind(db)
  throw new TypeError('PostgreSQL Media JobStore requires an injected query function or pool')
}

export function createPostgresMediaJobStore(options = {}) {
  const query = queryFunction(options)

  async function selectOwned(id, userId) {
    const { rows } = await query(
      'SELECT * FROM ai_jobs WHERE id=$1 AND user_id=$2 AND kind=ANY($3::text[]) LIMIT 1',
      [id, userId, MEDIA_KINDS],
    )
    return decode(rows[0])
  }

  async function selectIdempotent(userId, projectId, idempotencyKey) {
    const { rows } = await query(
      'SELECT * FROM ai_jobs WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3 LIMIT 1',
      [userId, projectId, idempotencyKey],
    )
    return rows[0] || null
  }

  async function compareAndSet({ id, userId, expectedVersion, mutate }) {
    const normalizedId = requireText(id, 'id', 100).toLowerCase()
    const normalizedUserId = requireText(userId, 'userId')
    requireVersion(expectedVersion)
    if (typeof mutate !== 'function') throw new TypeError('Media job mutate function is required')
    const current = await selectOwned(normalizedId, normalizedUserId)
    if (!current || current.version !== expectedVersion) return current
    const candidate = mutate(clone(current))
    assertImmutableScope(current, candidate)
    const prepared = normalizeRecord(candidate, current.version + 1)
    const availableAt = prepared.input.mediaEngine.nextReconcileAt || prepared.normalized.updatedAt
    const terminal = TERMINAL_STATUSES.has(prepared.normalized.status)
    const { rows } = await query(
      `UPDATE ai_jobs SET kind=$1,provider=$2,model=$3,status=$4,provider_job_id=$5,
        input=$6::jsonb,artifacts=$7::jsonb,usage=$8::jsonb,error=$9::jsonb,
        started_at=CASE WHEN $4='running' THEN COALESCE(started_at,$10::timestamptz) ELSE started_at END,
        finished_at=$11::timestamptz,updated_at=$12::timestamptz,available_at=$13::timestamptz,
        lease_owner=CASE WHEN $14 THEN NULL ELSE lease_owner END,
        lease_expires_at=CASE WHEN $14 THEN NULL ELSE lease_expires_at END,
        last_heartbeat_at=CASE WHEN $14 THEN NULL ELSE last_heartbeat_at END
       WHERE id=$15 AND user_id=$16 AND kind=$17
         AND (input #>> '{mediaEngine,version}')::bigint=$18
       RETURNING *`,
      [
        prepared.normalized.operation, prepared.normalized.provider, prepared.normalized.model, prepared.dbStatus,
        prepared.normalized.providerJobId, jsonValue(prepared.input, 'input'), jsonValue(prepared.normalized.artifacts, 'artifacts'),
        jsonValue(prepared.normalized.usage, 'usage'), prepared.normalized.error == null ? null : jsonValue(prepared.normalized.error, 'error'),
        prepared.normalized.updatedAt, prepared.normalized.finishedAt, prepared.normalized.updatedAt, availableAt, terminal,
        current.id, current.userId, current.operation, current.version,
      ],
    )
    if (rows[0]) return decode(rows[0])
    return selectOwned(normalizedId, normalizedUserId)
  }

  return Object.freeze({
    kind: 'postgres',

    async create(job) {
      const prepared = normalizeRecord(job, 1)
      if (!MEDIA_KINDS.includes(prepared.normalized.operation)) throw new TypeError('PostgreSQL Media JobStore accepts only supported media jobs')
      const availableAt = prepared.input.mediaEngine.nextReconcileAt || prepared.normalized.updatedAt
      const { rows } = await query(
        `INSERT INTO ai_jobs
          (id,user_id,project_id,kind,provider,model,status,idempotency_key,provider_job_id,input,artifacts,usage,error,
           retry_count,available_at,created_at,finished_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,0,$14::timestamptz,$15::timestamptz,$16::timestamptz,$17::timestamptz)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          prepared.normalized.id, prepared.normalized.userId, prepared.normalized.projectId, prepared.normalized.operation,
          prepared.normalized.provider, prepared.normalized.model, prepared.dbStatus, prepared.normalized.idempotencyKey,
          prepared.normalized.providerJobId, jsonValue(prepared.input, 'input'), jsonValue(prepared.normalized.artifacts, 'artifacts'),
          jsonValue(prepared.normalized.usage, 'usage'), prepared.normalized.error == null ? null : jsonValue(prepared.normalized.error, 'error'),
          availableAt, prepared.normalized.createdAt, prepared.normalized.finishedAt, prepared.normalized.updatedAt,
        ],
      )
      if (rows[0]) return { job: decode(rows[0]), created: true }
      const existingRow = await selectIdempotent(prepared.normalized.userId, prepared.normalized.projectId, prepared.normalized.idempotencyKey)
      if (!existingRow) throw new MediaJobError('MEDIA_JOB_ID_CONFLICT', 'Media job identity already exists', { status: 409 })
      if (existingRow.kind !== prepared.normalized.operation) {
        throw new MediaJobError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key is already bound to another job kind', { status: 409 })
      }
      const existing = decode(existingRow)
      if (existing.requestFingerprint !== prepared.input.mediaEngine.requestFingerprint) {
        throw new MediaJobError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with different media input', { status: 409 })
      }
      return { job: existing, created: false }
    },

    async getOwned({ id, userId }) {
      return selectOwned(requireText(id, 'id', 100).toLowerCase(), requireText(userId, 'userId'))
    },

    compareAndSet,

    async attachProviderJobId({ id, userId, providerJobId }) {
      const normalizedId = requireText(id, 'id', 100).toLowerCase()
      const normalizedUserId = requireText(userId, 'userId')
      const normalizedProviderJobId = requireText(providerJobId, 'providerJobId')
      const { rows } = await query(
        `UPDATE ai_jobs SET provider_job_id=$3,error=NULL,
          input=jsonb_set(input,'{mediaEngine}',
            (input->'mediaEngine') || jsonb_build_object(
              'version',((input #>> '{mediaEngine,version}')::bigint + 1),
              'submissionState','submitted','consecutiveControlPlaneErrors',0,
              'reconciliationState','active','nextReconcileAt',NULL
            ),false)
         WHERE id=$1 AND user_id=$2 AND kind=ANY($4::text[]) AND provider_job_id IS NULL
           AND input #>> '{mediaEngine,schemaVersion}'=$5
         RETURNING *`,
        [normalizedId, normalizedUserId, normalizedProviderJobId, MEDIA_KINDS, STORE_SCHEMA_VERSION],
      )
      if (rows[0]) return decode(rows[0])
      const current = await selectOwned(normalizedId, normalizedUserId)
      if (!current) return null
      if (current.providerJobId && current.providerJobId !== normalizedProviderJobId) {
        throw new MediaJobError('PROVIDER_JOB_ID_CONFLICT', 'Media job is already bound to another provider job', { status: 409 })
      }
      return current
    },

    async count() {
      const { rows } = await query('SELECT COUNT(*)::int AS count FROM ai_jobs WHERE kind=ANY($1::text[])', [MEDIA_KINDS])
      const count = Number(rows[0]?.count)
      if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('PostgreSQL Media JobStore returned an invalid count')
      return count
    },
  })
}

export { MEDIA_KINDS as POSTGRES_MEDIA_JOB_KINDS, STORE_SCHEMA_VERSION as POSTGRES_MEDIA_JOB_STORE_SCHEMA_VERSION }
