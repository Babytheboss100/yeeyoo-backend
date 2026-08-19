import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
import { createPostgresVideoLeaseStore } from '../src/mediaEngine/jobs/postgresVideoLeaseStore.js'
import { createVideoLeaseRunner } from '../src/mediaEngine/jobs/videoLeaseRunner.js'
import { createVideoRenderRequest } from '../src/mediaEngine/providers/composerVideo.js'
import { startVideoLeaseRunnerFromEnv } from '../src/mediaEngine/jobs/videoLeaseBootstrap.js'
import { startStandaloneVideoRunner } from '../src/mediaEngine/runner.js'
import { createVideoLeaseWorkspace } from '../src/mediaEngine/jobs/videoLeaseWorkspace.js'
import { createMediaJobService } from '../src/mediaEngine/jobs/jobService.js'
import { createInMemoryMediaJobStore } from '../src/mediaEngine/jobs/memoryJobStore.js'
import { createFakeImageProvider } from '../src/mediaEngine/providers/fakeProvider.js'
import { createComposerVideoProvider } from '../src/mediaEngine/providers/composerVideo.js'

const PROJECT = { schemaVersion: 1, kind: 'reel', canvas: { width: 108, height: 192, fps: 30, background: '#000' }, scenes: [{ id: 's', duration: 1, elements: [] }], captions: [] }

function row(overrides = {}) {
  const request = createVideoRenderRequest({ jobRef: '00000000-0000-4000-8000-000000000001', project: PROJECT })
  return { id: request.jobRef, user_id: 'u1', project_id: 'p1', kind: 'video.render', provider: 'composer-video', status: 'running', input: { mediaEngine: { workerRequest: request } }, artifacts: [], usage: {}, retry_count: 0, max_retries: 2, lease_owner: 'worker-1', ...overrides }
}

function leaseJob(overrides = {}) {
  const value = row()
  return { id: value.id, userId: value.user_id, projectId: value.project_id, status: 'queued', input: value.input, ...overrides }
}

function sharedLeaseSimulation({ now = [0], initial = leaseJob(), leaseMs = 5000 } = {}) {
  let job = structuredClone(initial)
  return {
    snapshot: () => structuredClone(job),
    store: {
      async recoverExpired() {
        if (job.status === 'running' && job.leaseExpiresAt < now[0]) job = { ...job, status: 'queued', leaseOwner: null, leaseExpiresAt: null }
        return []
      },
      async claim({ workerId }) {
        if (job.status !== 'queued') return null
        job = { ...job, status: 'running', leaseOwner: workerId, leaseExpiresAt: now[0] + leaseMs }
        return structuredClone(job)
      },
      async heartbeat({ id, workerId }) {
        if (job.id !== id || job.status !== 'running' || job.leaseOwner !== workerId || job.leaseExpiresAt < now[0]) return false
        job = { ...job, leaseExpiresAt: now[0] + leaseMs }
        return true
      },
      async complete({ id, workerId, artifacts, usage }) {
        if (job.id !== id || job.status !== 'running' || job.leaseOwner !== workerId || job.leaseExpiresAt < now[0]) return null
        job = { ...job, status: 'succeeded', artifacts, usage, leaseOwner: null, leaseExpiresAt: null }
        return structuredClone(job)
      },
      async fail({ workerId }) {
        if (job.status !== 'running' || job.leaseOwner !== workerId) return null
        job = { ...job, status: 'failed', leaseOwner: null, leaseExpiresAt: null }
        return structuredClone(job)
      },
      async get() { return structuredClone(job) },
    },
  }
}

function runnerFixture(store, { workerId, execute, workspace, setIntervalImpl = () => 1 } = {}) {
  const sha256 = crypto.createHash('sha256').update('mp4').digest('hex')
  const stored = { storage: 'test', objectRef: `media/${sha256}.mp4`, mimeType: 'video/mp4', sha256, sizeBytes: 3, persistent: true }
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() { return stored } }
  return createVideoLeaseRunner({
    workerId, store, storage, workspace, leaseSeconds: 5, heartbeatMs: 100,
    setIntervalImpl, clearIntervalImpl() {},
    resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {}, genomeHints: {} }),
    execute: execute || (async () => ({ stored, genome: { version: 1 }, composerProjectSha256: 'a'.repeat(64), render: { sha256, sizeBytes: 3 } })),
  })
}

test('PostgreSQL video lease store uses canonical exclusive claim, heartbeat and recovery fields', async () => {
  const calls = []
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: sql.includes('RETURNING j.*') ? [row()] : [] } } }
  const store = createPostgresVideoLeaseStore({ db })
  await store.recoverExpired()
  await store.claim({ workerId: 'worker-1', leaseSeconds: 90 })
  await store.heartbeat({ id: row().id, workerId: 'worker-1', leaseSeconds: 90 })
  await store.fail({ id: row().id, workerId: 'worker-1', error: { code: 'TEMP' }, retryable: true })
  assert.match(calls[0].sql, /lease_expires_at<NOW\(\)/)
  assert.match(calls[0].sql, /retry_count<max_retries/)
  assert.match(calls[0].sql, /last_heartbeat_at=NULL/)
  assert.match(calls[0].sql, /mediaEngine,version/)
  assert.match(calls[1].sql, /FOR UPDATE SKIP LOCKED/)
  assert.match(calls[1].sql, /available_at<=NOW\(\)/)
  assert.match(calls[1].sql, /lease_owner=\$3/)
  assert.match(calls[1].sql, /last_heartbeat_at=NOW\(\)/)
  assert.match(calls[2].sql, /status='running' AND lease_owner=\$2/)
  assert.match(calls[2].sql, /lease_expires_at>=NOW\(\)/)
  assert.match(calls[3].sql, /to_jsonb\(\$3 AND retry_count<max_retries\)/)
  for (const call of calls) for (const forbidden of ['locked_at', 'locked_by', 'heartbeat_at', 'next_attempt_at', 'max_attempts']) assert.doesNotMatch(call.sql, new RegExp(`\\b${forbidden}\\b`))
})

test('runner persists only checksum-bound StorageAdapter result under its live lease', async () => {
  const source = row()
  const sha256 = crypto.createHash('sha256').update('mp4').digest('hex')
  const stored = { storage: 'test', objectRef: `media/${sha256}.mp4`, mimeType: 'video/mp4', sha256, sizeBytes: 3, persistent: true }
  let completion
  const store = {
    recoverExpired: async () => [], claim: async () => source, heartbeat: async () => true,
    complete: async value => { completion = value; return { ...source, status: 'succeeded' } },
    fail: async () => { throw new Error('unexpected failure') }, get: async () => source,
  }
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() { return stored } }
  const runner = createVideoLeaseRunner({
    workerId: 'worker-1', store, storage, heartbeatMs: 100, setIntervalImpl: () => 1, clearIntervalImpl() {},
    resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {}, genomeHints: {} }),
    execute: async ({ signal }) => ({ stored, genome: { version: 1 }, composerProjectSha256: 'a'.repeat(64), render: { sha256, sizeBytes: 3 }, signal }),
  })
  const result = await runner.runOnce()
  assert.equal(result.state, 'succeeded')
  assert.equal(completion.artifacts[0].sha256, sha256)
  assert.equal(completion.artifacts[0].requestHash, source.input.mediaEngine.workerRequest.requestHash)
  assert.equal(completion.usage.billable, false)
})

test('runner aborts on lost heartbeat and reports durable cancellation without completing or failing', async () => {
  const source = row()
  let tick
  let completeCalls = 0
  let failCalls = 0
  const store = {
    recoverExpired: async () => [], claim: async () => source, heartbeat: async () => false,
    complete: async () => { completeCalls += 1 }, fail: async () => { failCalls += 1 },
    get: async () => ({ ...source, status: 'cancelled' }),
  }
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() { throw new Error('not reached') } }
  const runner = createVideoLeaseRunner({
    workerId: 'worker-1', store, storage, heartbeatMs: 100,
    setIntervalImpl: callback => { tick = callback; return 1 }, clearIntervalImpl() {},
    resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {} }),
    execute: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true })
      void tick()
    }),
  })
  const result = await runner.runOnce()
  assert.equal(result.state, 'cancelled')
  assert.equal(completeCalls, 0)
  assert.equal(failCalls, 0)
})

test('an in-flight heartbeat is awaited and fences terminal persistence after render resolves', async () => {
  const source = leaseJob({ status: 'running', leaseOwner: 'worker-1', leaseExpiresAt: 1000 })
  let tick
  let releaseRender
  let resolveHeartbeat
  let completeCalls = 0
  let failCalls = 0
  const store = {
    recoverExpired: async () => [], claim: async () => source,
    heartbeat: async () => new Promise(resolve => { resolveHeartbeat = resolve }),
    complete: async () => { completeCalls += 1 }, fail: async () => { failCalls += 1 },
    get: async () => ({ ...source, status: 'cancelled' }),
  }
  const sha256 = crypto.createHash('sha256').update('mp4').digest('hex')
  const stored = { storage: 'test', objectRef: `media/${sha256}.mp4`, mimeType: 'video/mp4', sha256, sizeBytes: 3, persistent: true }
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() { return stored } }
  const runner = createVideoLeaseRunner({
    workerId: 'worker-1', store, storage, leaseSeconds: 5, heartbeatMs: 100,
    setIntervalImpl: callback => { tick = callback; return 1 }, clearIntervalImpl() {},
    resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {} }),
    execute: async () => new Promise(resolve => { releaseRender = () => resolve({ stored, genome: {}, composerProjectSha256: 'a'.repeat(64), render: { sha256, sizeBytes: 3 } }) }),
  })
  const running = runner.runOnce()
  while (!tick || !releaseRender) await new Promise(resolve => setImmediate(resolve))
  const heartbeatTick = tick()
  while (!resolveHeartbeat) await new Promise(resolve => setImmediate(resolve))
  releaseRender()
  resolveHeartbeat(false)
  await heartbeatTick
  assert.equal((await running).state, 'cancelled')
  assert.equal(completeCalls, 0)
  assert.equal(failCalls, 0)
})

test('runner failure is sanitized and retry policy is delegated to canonical retry fields', async () => {
  const source = row()
  let failure
  const store = {
    recoverExpired: async () => [], claim: async () => source, heartbeat: async () => true,
    complete: async () => null, fail: async value => { failure = value; return { ...source, status: 'queued' } }, get: async () => source,
  }
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() {} }
  const runner = createVideoLeaseRunner({ workerId: 'worker-1', store, storage, heartbeatMs: 100, setIntervalImpl: () => 1, clearIntervalImpl() {}, resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {} }), execute: async () => { throw Object.assign(new Error('SECRET'), { code: 'TEMP', retryable: true }) } })
  assert.equal((await runner.runOnce()).state, 'queued')
  assert.equal(failure.retryable, true)
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/)
})

test('bootstrap is inert by default and requires canonical DB only behind explicit env', async () => {
  assert.equal(await startVideoLeaseRunnerFromEnv({ env: {} }), null)
  await assert.rejects(startVideoLeaseRunnerFromEnv({ env: { MEDIA_VIDEO_LEASE_RUNNER_ENABLED: 'true' } }), /MEDIA_JOB_STORE=postgres/)
  await assert.rejects(startVideoLeaseRunnerFromEnv({ env: { MEDIA_VIDEO_LEASE_RUNNER_ENABLED: 'true', MEDIA_JOB_STORE: 'postgres' } }), /injected canonical PostgreSQL pool/)
})

test('embedded and standalone modes use an explicit cron sweep and never overlap polls', async () => {
  let scheduled
  let starts = 0
  let stops = 0
  const scheduleImpl = (expression, callback, options) => {
    scheduled = { expression, callback, options }
    return { start() { starts += 1 }, stop() { stops += 1 } }
  }
  const db = { query: async sql => ({ rows: sql.includes('RETURNING *') ? [] : [] }) }
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() {} }
  const dependencies = { storage, resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {} }), execute: async () => { throw new Error('not reached') } }
  const env = { MEDIA_JOB_STORE: 'postgres', MEDIA_VIDEO_RUNNER_MODE: 'embedded', MEDIA_VIDEO_CRON: '*/5 * * * * *', MEDIA_VIDEO_LEASE_WORKER_ID: 'embedded-1' }
  const embedded = await startVideoLeaseRunnerFromEnv({ env, db, dependencies, scheduleImpl, runtimeMode: 'embedded' })
  assert.equal(embedded.runtimeMode, 'embedded')
  assert.equal(scheduled.expression, '*/5 * * * * *')
  assert.equal(scheduled.options.scheduled, false)
  assert.equal(starts, 1)
  await embedded.stop()
  assert.equal(stops, 1)

  const standalone = await startStandaloneVideoRunner({ env: { ...env, MEDIA_VIDEO_RUNNER_MODE: 'standalone' }, db, dependencies, scheduleImpl })
  assert.equal(standalone.runtimeMode, 'standalone')
  await standalone.stop()
  assert.equal(stops, 2)
})

test('deferred video jobs stay queued for the lease runner and cancel durably without process-local submit', async () => {
  let executions = 0
  const storage = { capabilities() { return {} }, async put() {}, async get() {}, async stat() {} }
  const service = createMediaJobService({
    store: createInMemoryMediaJobStore(), storage,
    providers: { 'image.generate': createFakeImageProvider(), 'video.render': createComposerVideoProvider({ storage, execute: async () => { executions += 1 } }) },
    resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {} }),
    deferredOperations: ['video.render'],
  })
  const created = await service.create({ userId: 'u1', input: { projectId: 'p1', operation: 'video.render', project: PROJECT }, idempotencyKey: 'deferred-video' })
  assert.equal(created.job.status, 'queued')
  assert.equal(executions, 0)
  assert.equal((await service.refresh({ id: created.job.id, userId: 'u1' })).status, 'queued')
  assert.equal((await service.cancel({ id: created.job.id, userId: 'u1' })).status, 'cancelled')
  assert.equal(executions, 0)
})

test('two runners compete for one claim and exactly one executes', async () => {
  const shared = sharedLeaseSimulation()
  let executions = 0
  const execute = async () => {
    executions += 1
    const sha256 = crypto.createHash('sha256').update('mp4').digest('hex')
    return { stored: { storage: 'test', objectRef: `media/${sha256}.mp4`, mimeType: 'video/mp4', sha256, sizeBytes: 3, persistent: true }, genome: {}, composerProjectSha256: 'a'.repeat(64), render: { sha256, sizeBytes: 3 } }
  }
  const [a, b] = await Promise.all([
    runnerFixture(shared.store, { workerId: 'runner-a', execute }).runOnce(),
    runnerFixture(shared.store, { workerId: 'runner-b', execute }).runOnce(),
  ])
  assert.equal(executions, 1)
  assert.equal([a, b].filter(Boolean).length, 1)
  assert.equal(shared.snapshot().status, 'succeeded')
})

test('heartbeat prevents reclaim, while an expired dead lease is reclaimed', async () => {
  const now = [0]
  const shared = sharedLeaseSimulation({ now })
  let tick
  let release
  const first = runnerFixture(shared.store, {
    workerId: 'runner-a',
    setIntervalImpl: callback => { tick = callback; return 1 },
    execute: async () => new Promise(resolve => { release = resolve }),
  })
  const active = first.runOnce()
  while (!tick || !release) await new Promise(resolve => setImmediate(resolve))
  now[0] = 4_000
  await tick()
  now[0] = 6_000
  assert.equal(await runnerFixture(shared.store, { workerId: 'runner-b' }).runOnce(), null)
  const sha256 = crypto.createHash('sha256').update('mp4').digest('hex')
  release({ stored: { storage: 'test', objectRef: `media/${sha256}.mp4`, mimeType: 'video/mp4', sha256, sizeBytes: 3, persistent: true }, genome: {}, composerProjectSha256: 'a'.repeat(64), render: { sha256, sizeBytes: 3 } })
  await active

  const expired = sharedLeaseSimulation({ now, initial: leaseJob({ status: 'running', leaseOwner: 'dead-runner', leaseExpiresAt: now[0] - 1 }) })
  assert.equal((await runnerFixture(expired.store, { workerId: 'runner-c' }).runOnce()).state, 'succeeded')
  assert.equal(expired.snapshot().status, 'succeeded')
})

test('reclaim removes a crashed render workspace before executing and cleans terminal temp data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yeeyoo-video-lease-test-'))
  const workspace = createVideoLeaseWorkspace({ rootPath: root })
  const id = leaseJob().id
  const stale = await workspace.prepare(id)
  const marker = path.join(stale, 'orphan.tmp')
  await writeFile(marker, 'partial render')
  const shared = sharedLeaseSimulation({ now: [10], initial: leaseJob({ status: 'running', leaseOwner: 'dead-runner', leaseExpiresAt: 9 }) })
  let markerWasRemoved = false
  try {
    const result = await runnerFixture(shared.store, { workerId: 'runner-reclaim', workspace, execute: async ({ workspaceRoot }) => {
      try { await access(path.join(workspaceRoot, 'orphan.tmp')) } catch { markerWasRemoved = true }
      const sha256 = crypto.createHash('sha256').update('mp4').digest('hex')
      return { stored: { storage: 'test', objectRef: `media/${sha256}.mp4`, mimeType: 'video/mp4', sha256, sizeBytes: 3, persistent: true }, genome: {}, composerProjectSha256: 'a'.repeat(64), render: { sha256, sizeBytes: 3 } }
    } }).runOnce()
    assert.equal(result.state, 'succeeded')
    assert.equal(markerWasRemoved, true)
    await assert.rejects(access(stale))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an expired lease with no retry budget removes its terminal orphan workspace', async () => {
  const id = leaseJob().id
  const cleaned = []
  const store = {
    recoverExpired: async () => [{ id, status: 'failed' }],
    claim: async () => null,
    heartbeat: async () => false,
    complete: async () => null,
    fail: async () => null,
    get: async () => null,
  }
  const workspace = { async prepare() { throw new Error('not reached') }, async cleanup(value) { cleaned.push(value) } }
  assert.equal(await runnerFixture(store, { workerId: 'cleanup-runner', workspace }).runOnce(), null)
  assert.deepEqual(cleaned, [id])
})
