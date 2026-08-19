import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createPostgresMediaJobStore, POSTGRES_MEDIA_JOB_STORE_SCHEMA_VERSION } from '../src/mediaEngine/jobs/postgresJobStore.js'
import { createInMemoryMediaJobStore } from '../src/mediaEngine/jobs/memoryJobStore.js'

const NOW = '2026-08-19T12:00:00.000Z'
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STORE_SOURCE = fs.readFileSync(new URL('../src/mediaEngine/jobs/postgresJobStore.js', import.meta.url), 'utf8')

function record(overrides = {}) {
  return {
    id: ID,
    userId: 'user-a',
    projectId: 'project-a',
    operation: 'image.generate',
    provider: 'fake-image',
    model: 'z-image-turbo',
    status: 'queued',
    idempotencyKey: 'media-key',
    requestFingerprint: 'a'.repeat(64),
    workerRequest: { schemaVersion: 'yeeyoo.media.worker.v1', prompt: 'private prompt' },
    providerJobId: null,
    submissionState: 'submitting',
    cancelRequested: false,
    consecutiveControlPlaneErrors: 0,
    reconciliationState: 'active',
    nextReconcileAt: null,
    artifacts: [],
    usage: { attempts: 1 },
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    ...overrides,
  }
}

function rowFrom(job, version = 1) {
  return {
    id: job.id,
    user_id: job.userId,
    project_id: job.projectId,
    kind: job.operation,
    provider: job.provider,
    model: job.model,
    status: job.status === 'processing' ? 'running' : job.status,
    idempotency_key: job.idempotencyKey,
    provider_job_id: job.providerJobId,
    input: {
      mediaEngine: {
        schemaVersion: POSTGRES_MEDIA_JOB_STORE_SCHEMA_VERSION,
        version,
        requestFingerprint: job.requestFingerprint,
        workerRequest: job.workerRequest,
        submissionState: job.submissionState,
        cancelRequested: job.cancelRequested,
        consecutiveControlPlaneErrors: job.consecutiveControlPlaneErrors,
        reconciliationState: job.reconciliationState,
        nextReconcileAt: job.nextReconcileAt,
      },
    },
    artifacts: job.artifacts,
    usage: job.usage,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt,
  }
}

test('requires an injected PostgreSQL boundary and never imports the global pool', () => {
  assert.throws(() => createPostgresMediaJobStore(), /injected query function or pool/)
  const postgres = createPostgresMediaJobStore({ db: { query: async () => ({ rows: [] }) } })
  assert.equal(postgres.kind, 'postgres')
  assert.deepEqual(Object.keys(postgres), Object.keys(createInMemoryMediaJobStore()))
  assert.doesNotMatch(STORE_SOURCE, /from\s+['"][^'"]*db\.js['"]/) 
  assert.doesNotMatch(STORE_SOURCE, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX)\b/i)
  for (const alias of ['locked_at', 'locked_by', 'heartbeat_at', 'next_attempt_at', 'max_attempts']) assert.doesNotMatch(STORE_SOURCE, new RegExp(`\\b${alias}\\b`))
})

test('create persists a canonical ai_jobs row and returns the memory-store shape', async () => {
  const calls = []
  const source = record()
  const store = createPostgresMediaJobStore({ query: async (sql, values) => {
    calls.push({ sql, values })
    const input = JSON.parse(values[9])
    return { rows: [rowFrom({ ...source, workerRequest: input.mediaEngine.workerRequest }, 1)] }
  } })
  const result = await store.create(source)
  assert.equal(result.created, true)
  assert.equal(result.job.version, 1)
  assert.equal(result.job.workerRequest.prompt, 'private prompt')
  assert.match(calls[0].sql, /INSERT INTO ai_jobs/)
  for (const canonical of ['retry_count', 'available_at']) assert.match(calls[0].sql, new RegExp(canonical))
  for (const forbidden of ['locked_at', 'locked_by', 'heartbeat_at', 'next_attempt_at', 'max_attempts']) assert.doesNotMatch(calls[0].sql, new RegExp(forbidden))
  assert.equal(JSON.parse(calls[0].values[9]).mediaEngine.schemaVersion, POSTGRES_MEDIA_JOB_STORE_SCHEMA_VERSION)
})

test('create accepts video.render behind the same durable JobStore interface', async () => {
  const source = record({ operation: 'video.render', provider: 'composer-video', model: 'composer-v0.3.1' })
  const store = createPostgresMediaJobStore({ query: async (_sql, values) => ({ rows: [rowFrom(source, 1)] }) })
  const result = await store.create(source)
  assert.equal(result.created, true)
  assert.equal(result.job.operation, 'video.render')
})

test('create replays the exact scoped idempotency key and rejects changed input', async () => {
  const existing = record()
  let fingerprint = existing.requestFingerprint
  const store = createPostgresMediaJobStore({ query: async sql => {
    if (/INSERT INTO/.test(sql)) return { rows: [] }
    return { rows: [rowFrom({ ...existing, requestFingerprint: fingerprint })] }
  } })
  const replay = await store.create(existing)
  assert.equal(replay.created, false)
  assert.equal(replay.job.id, ID)
  fingerprint = 'b'.repeat(64)
  await assert.rejects(store.create(existing), { code: 'IDEMPOTENCY_CONFLICT', status: 409 })
})

test('create distinguishes a primary-key collision from scoped idempotent replay', async () => {
  const store = createPostgresMediaJobStore({ query: async sql => ({ rows: /INSERT INTO/.test(sql) ? [] : [] }) })
  await assert.rejects(store.create(record()), { code: 'MEDIA_JOB_ID_CONFLICT', status: 409 })
})

test('create fails closed when the scoped key belongs to another canonical job kind', async () => {
  const foreign = { ...rowFrom(record()), kind: 'voice.turn', input: {} }
  const store = createPostgresMediaJobStore({ query: async sql => ({ rows: /INSERT INTO/.test(sql) ? [] : [foreign] }) })
  await assert.rejects(store.create(record()), { code: 'IDEMPOTENCY_CONFLICT', status: 409 })
})

test('getOwned is user-bound and decodes canonical running as local processing', async () => {
  const calls = []
  const processing = record({ status: 'processing' })
  const store = createPostgresMediaJobStore({ query: async (sql, values) => {
    calls.push({ sql, values })
    return { rows: values[1] === 'user-a' ? [rowFrom(processing)] : [] }
  } })
  assert.equal((await store.getOwned({ id: ID.toUpperCase(), userId: 'user-a' })).status, 'processing')
  assert.equal(await store.getOwned({ id: ID, userId: 'user-b' }), null)
  assert.match(calls[0].sql, /id=\$1 AND user_id=\$2 AND kind=ANY\(\$3::text\[\]\)/)
  assert.equal(calls[0].values[0], ID)
})

test('getOwned fails closed on malformed persisted media metadata', async () => {
  const malformed = { ...rowFrom(record()), input: { mediaEngine: { schemaVersion: POSTGRES_MEDIA_JOB_STORE_SCHEMA_VERSION, version: 1 } } }
  const store = createPostgresMediaJobStore({ query: async () => ({ rows: [malformed] }) })
  await assert.rejects(store.getOwned({ id: ID, userId: 'user-a' }), /persisted requestFingerprint/)
})

test('compareAndSet skips mutation on a stale version', async () => {
  let mutated = false
  let queries = 0
  const store = createPostgresMediaJobStore({ query: async () => {
    queries += 1
    return { rows: [rowFrom(record(), 2)] }
  } })
  const current = await store.compareAndSet({ id: ID, userId: 'user-a', expectedVersion: 1, mutate: value => { mutated = true; return value } })
  assert.equal(current.version, 2)
  assert.equal(mutated, false)
  assert.equal(queries, 1)
})

test('compareAndSet uses JSONB version CAS, canonical leases and available_at', async () => {
  const calls = []
  const current = record()
  const next = '2026-08-19T12:00:05.000Z'
  const store = createPostgresMediaJobStore({ query: async (sql, values) => {
    calls.push({ sql, values })
    if (/^SELECT \*/.test(sql)) return { rows: [rowFrom(current, 1)] }
    const input = JSON.parse(values[5])
    const updated = { ...current, status: 'processing', nextReconcileAt: next, updatedAt: next }
    return { rows: [rowFrom({ ...updated, workerRequest: input.mediaEngine.workerRequest }, 2)] }
  } })
  const updated = await store.compareAndSet({
    id: ID,
    userId: 'user-a',
    expectedVersion: 1,
    mutate: value => ({ ...value, status: 'processing', nextReconcileAt: next, updatedAt: next }),
  })
  assert.equal(updated.status, 'processing')
  assert.equal(updated.version, 2)
  assert.match(calls[1].sql, /\(input #>> '\{mediaEngine,version\}'\)::bigint=\$18/)
  for (const canonical of ['available_at', 'lease_owner', 'lease_expires_at', 'last_heartbeat_at']) assert.match(calls[1].sql, new RegExp(canonical))
  assert.equal(calls[1].values[3], 'running')
  assert.equal(calls[1].values[12], next)
})

test('compareAndSet returns the winning row after a lost race', async () => {
  let selects = 0
  const original = record()
  const winner = { ...original, status: 'processing', updatedAt: '2026-08-19T12:00:01.000Z' }
  const store = createPostgresMediaJobStore({ query: async sql => {
    if (/^SELECT \*/.test(sql)) return { rows: [rowFrom(selects++ === 0 ? original : winner, selects === 1 ? 1 : 2)] }
    return { rows: [] }
  } })
  const result = await store.compareAndSet({ id: ID, userId: 'user-a', expectedVersion: 1, mutate: value => ({ ...value, status: 'failed', finishedAt: NOW }) })
  assert.equal(result.status, 'processing')
  assert.equal(result.version, 2)
})

test('compareAndSet rejects immutable tenant or idempotency changes before update', async () => {
  let updates = 0
  const store = createPostgresMediaJobStore({ query: async sql => {
    if (/^SELECT \*/.test(sql)) return { rows: [rowFrom(record())] }
    updates += 1
    return { rows: [] }
  } })
  await assert.rejects(store.compareAndSet({ id: ID, userId: 'user-a', expectedVersion: 1, mutate: value => ({ ...value, projectId: 'foreign-project' }) }), /immutable scope/)
  assert.equal(updates, 0)
})

test('attachProviderJobId is atomic, idempotent and detects a conflicting provider binding', async () => {
  const base = record()
  let mode = 'attach'
  const store = createPostgresMediaJobStore({ query: async sql => {
    if (/^UPDATE ai_jobs SET provider_job_id/.test(sql)) {
      if (mode !== 'attach') return { rows: [] }
      return { rows: [rowFrom({ ...base, providerJobId: 'provider-1', submissionState: 'submitted' }, 2)] }
    }
    const providerJobId = mode === 'same' ? 'provider-1' : mode === 'conflict' ? 'provider-2' : null
    return { rows: [rowFrom({ ...base, providerJobId }, providerJobId ? 2 : 1)] }
  } })
  assert.equal((await store.attachProviderJobId({ id: ID, userId: 'user-a', providerJobId: 'provider-1' })).version, 2)
  mode = 'same'
  assert.equal((await store.attachProviderJobId({ id: ID, userId: 'user-a', providerJobId: 'provider-1' })).providerJobId, 'provider-1')
  mode = 'conflict'
  await assert.rejects(store.attachProviderJobId({ id: ID, userId: 'user-a', providerJobId: 'provider-1' }), { code: 'PROVIDER_JOB_ID_CONFLICT', status: 409 })
})

test('count is restricted to the canonical media kinds', async () => {
  let captured
  const store = createPostgresMediaJobStore({ query: async (sql, values) => { captured = { sql, values }; return { rows: [{ count: 7 }] } } })
  assert.equal(await store.count(), 7)
  assert.match(captured.sql, /WHERE kind=ANY\(\$1::text\[\]\)/)
  assert.deepEqual(captured.values, [['image.generate', 'video.render']])
})
