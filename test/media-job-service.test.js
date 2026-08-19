import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { createFakeImageProvider } from '../src/mediaEngine/providers/fakeProvider.js'
import { ProviderAdapterError } from '../src/mediaEngine/contracts/provider.js'
import { createInMemoryMediaJobStore } from '../src/mediaEngine/jobs/memoryJobStore.js'
import { createMediaJobService } from '../src/mediaEngine/jobs/jobService.js'
import { createLocalDiskStorageAdapter } from '../src/mediaEngine/storage/localDiskFake.js'

const INPUT = Object.freeze({
  projectId: 'project-a',
  operation: 'image.generate',
  prompt: 'A restrained Nordic fintech campaign hero',
  width: 1024,
  height: 1024,
  seed: 42,
})

async function fixture(t, { scenarioForRequest, provider: injectedProvider, store: injectedStore, storage: injectedStorage, idFactory, serviceOptions = {} } = {}) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'yeeyoo-media-job-test-'))
  t.after(() => rm(rootPath, { recursive: true, force: true }))
  const store = injectedStore || createInMemoryMediaJobStore()
  const provider = injectedProvider || createFakeImageProvider({ scenarioForRequest })
  const storage = injectedStorage || createLocalDiskStorageAdapter({ rootPath })
  const service = createMediaJobService({ store, provider, storage, idFactory, ...serviceOptions })
  return { service, store, storage, provider }
}

test('create is idempotent per user, project and key without a second provider job', async t => {
  const { service, store } = await fixture(t)
  const first = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-1' })
  const replay = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-1' })
  assert.equal(first.created, true)
  assert.equal(replay.created, false)
  assert.equal(replay.job.id, first.job.id)
  assert.equal(await store.count(), 1)
  assert.equal(first.job.status, 'queued')
  assert.equal(first.job.cancelRequested, false)
})

test('idempotency reuse with changed semantic input fails closed', async t => {
  const { service } = await fixture(t)
  await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-1' })
  await assert.rejects(service.create({ userId: 'user-a', input: { ...INPUT, prompt: 'Changed prompt' }, idempotencyKey: 'media-1' }), { code: 'IDEMPOTENCY_CONFLICT', status: 409 })
})

test('polling persists a validated fake artifact and never exposes raw request data', async t => {
  const { service, storage } = await fixture(t)
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-1' })
  const processing = await service.refresh({ id: created.job.id, userId: 'user-a' })
  const completed = await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(processing.status, 'processing')
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.artifacts.length, 1)
  assert.equal(completed.artifacts[0].persistent, false)
  assert.ok((await storage.get(completed.artifacts[0].objectRef)).length > 100)
  const serialized = JSON.stringify(completed)
  assert.doesNotMatch(serialized, /restrained Nordic fintech/)
  for (const privateField of ['workerRequest', 'requestFingerprint', 'idempotencyKey', 'userId', 'providerJobId']) assert.equal(privateField in completed, false)
})

test('preview is owner-bound and returns checksum-verified inline bytes only after success', async t => {
  const { service } = await fixture(t)
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-preview' })
  await assert.rejects(service.getPreview({ id: created.job.id, userId: 'user-a' }), { code: 'MEDIA_PREVIEW_NOT_READY', status: 409 })
  assert.equal(await service.getPreview({ id: created.job.id, userId: 'user-b' }), null)
  await service.refresh({ id: created.job.id, userId: 'user-a' })
  const completed = await service.refresh({ id: created.job.id, userId: 'user-a' })
  const preview = await service.getPreview({ id: created.job.id, userId: 'user-a' })
  assert.equal(preview.jobId, created.job.id)
  assert.equal(preview.mimeType, 'image/png')
  assert.equal(Buffer.from(preview.inlineBase64, 'base64').length, preview.sizeBytes)
  assert.equal(preview.sha256, completed.artifacts[0].sha256)
})

test('preview rejects oversized metadata before reading storage bytes', async t => {
  const { service, store } = await fixture(t)
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-preview-limit' })
  await service.refresh({ id: created.job.id, userId: 'user-a' })
  await service.refresh({ id: created.job.id, userId: 'user-a' })
  const raw = await store.getOwned({ id: created.job.id, userId: 'user-a' })
  await store.compareAndSet({ id: raw.id, userId: raw.userId, expectedVersion: raw.version, mutate: current => ({ ...current, artifacts: [{ ...current.artifacts[0], sizeBytes: 64 * 1024 * 1024 + 1 }] }) })
  await assert.rejects(service.getPreview({ id: created.job.id, userId: 'user-a' }), { code: 'MEDIA_PREVIEW_TOO_LARGE', status: 413 })
})

test('job reads are owner-bound and foreign users receive no existence signal', async t => {
  const { service } = await fixture(t)
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-1' })
  assert.equal(await service.getJob({ id: created.job.id, userId: 'user-b' }), null)
  assert.equal(await service.refresh({ id: created.job.id, userId: 'user-b' }), null)
  assert.equal(await service.cancel({ id: created.job.id, userId: 'user-b' }), null)
})

test('cancel is idempotent and a terminal job cannot be rolled back', async t => {
  const { service } = await fixture(t)
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-cancel' })
  const cancelled = await service.cancel({ id: created.job.id, userId: 'user-a' })
  const replay = await service.cancel({ id: created.job.id, userId: 'user-a' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(replay.status, 'cancelled')

  const second = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'media-complete' })
  await service.refresh({ id: second.job.id, userId: 'user-a' })
  const completed = await service.refresh({ id: second.job.id, userId: 'user-a' })
  assert.equal(completed.status, 'succeeded')
  assert.equal((await service.cancel({ id: second.job.id, userId: 'user-a' })).status, 'succeeded')
})

test('provider timeout becomes a truthful sanitized failed job with no automatic retry', async t => {
  const { service } = await fixture(t, { scenarioForRequest: () => 'timed_out' })
  const created = await service.create({ userId: 'user-a', input: { ...INPUT, prompt: 'PRIVATE-PROMPT-MUST-NOT-LEAK' }, idempotencyKey: 'media-timeout' })
  await service.refresh({ id: created.job.id, userId: 'user-a' })
  const failed = await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'PROVIDER_TIMEOUT')
  assert.equal(failed.error.retryable, true)
  assert.equal(failed.usage.attempts, 1)
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-PROMPT/)
})

test('request allowlist, deterministic seed and exact idempotency key are enforced', async t => {
  const { service } = await fixture(t)
  await assert.rejects(service.create({ userId: 'user-a', input: { ...INPUT, callbackUrl: 'https://attacker.invalid' }, idempotencyKey: 'media-1' }), { code: 'INVALID_MEDIA_JOB_REQUEST' })
  await assert.rejects(service.create({ userId: 'user-a', input: { ...INPUT, seed: undefined }, idempotencyKey: 'media-2' }), { code: 'INVALID_MEDIA_JOB_REQUEST' })
  await assert.rejects(service.create({ userId: 'user-a', input: INPUT, idempotencyKey: ' media-3 ' }), { code: 'IDEMPOTENCY_KEY_REQUIRED' })
  await assert.rejects(service.create({ userId: 'user-a', input: { ...INPUT, operation: 'video.generate' }, idempotencyKey: 'media-4' }), { code: 'UNSUPPORTED_MEDIA_OPERATION' })
})

test('cancel during submit is reconciled against the provider instead of orphaning work', async t => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let releaseSubmit
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const submitGate = new Promise(resolve => { releaseSubmit = resolve })
  const calls = []
  const provider = {
    name: 'deferred-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit() { calls.push('submit'); signalStarted(); await submitGate; return { providerJobId: 'provider-1' } },
    async getStatus() { return { providerJobId: 'provider-1', state: 'queued' } },
    async cancel(providerJobId) { calls.push(`cancel:${providerJobId}`); return { providerJobId, state: 'cancelled' } },
    normalizeResult: value => value,
  }
  const { service } = await fixture(t, { provider, idFactory: () => id })
  const creating = service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'race-create' })
  await started
  const requested = await service.cancel({ id, userId: 'user-a' })
  assert.equal(requested.status, 'queued')
  assert.equal(requested.cancelRequested, true)
  assert.equal(requested.finishedAt, null)
  releaseSubmit()
  const created = await creating
  assert.equal(created.job.status, 'cancelled')
  assert.deepEqual(calls, ['submit', 'cancel:provider-1'])
})

test('temporary status and cancel errors remain non-terminal for later reconciliation', async t => {
  const provider = {
    name: 'temporary-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit() { return { providerJobId: 'provider-temporary' } },
    async getStatus() { throw new ProviderAdapterError('PROVIDER_TIMEOUT', 'private transport detail', { retryable: true }) },
    async cancel() { throw new ProviderAdapterError('RATE_LIMITED', 'private transport detail', { retryable: true }) },
    normalizeResult: value => value,
  }
  const { service } = await fixture(t, { provider, serviceOptions: { reconciliationBackoffMs: 0 } })
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'temporary-errors' })
  const polled = await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(polled.status, 'queued')
  assert.equal(polled.finishedAt, null)
  assert.equal(polled.error.code, 'PROVIDER_TIMEOUT')
  const requested = await service.cancel({ id: created.job.id, userId: 'user-a' })
  assert.equal(requested.status, 'queued')
  assert.equal(requested.cancelRequested, true)
  assert.equal(requested.error.code, 'RATE_LIMITED')
  assert.equal(requested.usage.controlPlaneErrors, 2)
  assert.doesNotMatch(JSON.stringify(requested), /private transport detail/)
})

test('ambiguous submit timeout is recovered idempotently with the same jobRef', async t => {
  let submissions = 0
  const seenJobRefs = []
  const provider = {
    name: 'ambiguous-submit-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit(request) {
      submissions += 1
      seenJobRefs.push(request.jobRef)
      if (submissions === 1) throw new ProviderAdapterError('PROVIDER_TIMEOUT', 'unknown remote outcome', { retryable: true })
      return { providerJobId: 'recovered-provider-job' }
    },
    async getStatus(providerJobId) { return { providerJobId, state: 'processing' } },
    async cancel(providerJobId) { return { providerJobId, state: 'cancelled' } },
    normalizeResult: value => value,
  }
  const { service } = await fixture(t, { provider, serviceOptions: { reconciliationBackoffMs: 0 } })
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'ambiguous-submit' })
  assert.equal(created.job.status, 'queued')
  assert.equal(created.job.error.code, 'PROVIDER_TIMEOUT')
  const recovered = await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(recovered.status, 'processing')
  assert.equal(recovered.error, null)
  assert.equal(submissions, 2)
  assert.equal(recovered.usage.attempts, 2)
  assert.equal(recovered.usage.statusChecks, 1)
  assert.deepEqual(seenJobRefs, [created.job.id, created.job.id])
})

test('non-retryable status errors fail once while retryable polling backs off and pauses at a hard limit', async t => {
  const permanentProvider = {
    name: 'permanent-status-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit() { return { providerJobId: 'provider-permanent' } },
    async getStatus() { throw new ProviderAdapterError('RESULT_INVALID', 'malformed output detail', { retryable: false }) },
    async cancel(providerJobId) { return { providerJobId, state: 'cancelled' } },
    normalizeResult: value => value,
  }
  const permanent = await fixture(t, { provider: permanentProvider })
  const createdPermanent = await permanent.service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'permanent-status' })
  const failed = await permanent.service.refresh({ id: createdPermanent.job.id, userId: 'user-a' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'RESULT_INVALID')
  assert.equal(failed.usage.statusChecks, 1)

  let nowMs = Date.parse('2026-08-19T20:00:00.000Z')
  let polls = 0
  const retryableProvider = {
    ...permanentProvider,
    name: 'bounded-retry-test',
    async submit() { return { providerJobId: 'provider-retryable' } },
    async getStatus() { polls += 1; throw new ProviderAdapterError('PROVIDER_TIMEOUT', 'network detail', { retryable: true }) },
  }
  const retryable = await fixture(t, {
    provider: retryableProvider,
    serviceOptions: { clock: () => new Date(nowMs).toISOString(), maxControlPlaneErrors: 2, reconciliationBackoffMs: 1_000 },
  })
  const createdRetryable = await retryable.service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'bounded-retry' })
  const firstError = await retryable.service.refresh({ id: createdRetryable.job.id, userId: 'user-a' })
  assert.equal(firstError.reconciliation.paused, false)
  assert.equal(firstError.reconciliation.nextAttemptAt, '2026-08-19T20:00:01.000Z')
  await retryable.service.refresh({ id: createdRetryable.job.id, userId: 'user-a' })
  assert.equal(polls, 1)
  nowMs += 1_000
  const paused = await retryable.service.refresh({ id: createdRetryable.job.id, userId: 'user-a' })
  assert.equal(paused.status, 'queued')
  assert.equal(paused.reconciliation.paused, true)
  assert.equal(paused.reconciliation.nextAttemptAt, null)
  await retryable.service.refresh({ id: createdRetryable.job.id, userId: 'user-a' })
  assert.equal(polls, 2)
})

test('provider cancellation that remains queued backs off and pauses instead of looping forever', async t => {
  let nowMs = Date.parse('2026-08-19T20:00:00.000Z')
  let cancelCalls = 0
  const provider = {
    name: 'pending-cancel-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit() { return { providerJobId: 'provider-pending-cancel' } },
    async getStatus(providerJobId) { return { providerJobId, state: 'queued' } },
    async cancel(providerJobId) { cancelCalls += 1; return { providerJobId, state: 'queued' } },
    normalizeResult: value => value,
  }
  const { service } = await fixture(t, {
    provider,
    serviceOptions: { clock: () => new Date(nowMs).toISOString(), maxControlPlaneErrors: 2, reconciliationBackoffMs: 1_000 },
  })
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'pending-cancel' })
  const requested = await service.cancel({ id: created.job.id, userId: 'user-a' })
  assert.equal(requested.error.code, 'PROVIDER_TEMPORARY')
  assert.equal(requested.reconciliation.nextAttemptAt, '2026-08-19T20:00:01.000Z')
  await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(cancelCalls, 1)
  nowMs += 1_000
  const paused = await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(paused.reconciliation.paused, true)
  assert.equal(paused.cancelRequested, true)
  assert.equal(paused.usage.cancelAttempts, 2)
  await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(cancelCalls, 2)

  const malformedProvider = { ...provider, async cancel() { return { providerJobId: 'provider-pending-cancel', state: 'PRIVATE_INVALID_STATE' } } }
  const malformed = await fixture(t, {
    provider: malformedProvider,
    serviceOptions: { maxControlPlaneErrors: 1, reconciliationBackoffMs: 0 },
  })
  const malformedCreated = await malformed.service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'malformed-cancel-state' })
  const bounded = await malformed.service.cancel({ id: malformedCreated.job.id, userId: 'user-a' })
  assert.equal(bounded.status, 'queued')
  assert.equal(bounded.error.code, 'PROVIDER_TEMPORARY')
  assert.equal(bounded.reconciliation.paused, true)
})

test('non-retryable cancel rejection resumes ordinary status observation without an invalid paused state', async t => {
  const provider = {
    name: 'rejected-cancel-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit() { return { providerJobId: 'provider-rejected-cancel' } },
    async getStatus(providerJobId) { return { providerJobId, state: 'processing' } },
    async cancel() { throw new ProviderAdapterError('AUTH_ERROR', 'private credential detail', { retryable: false }) },
    normalizeResult: value => value,
  }
  const { service } = await fixture(t, { provider })
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'rejected-cancel' })
  const rejected = await service.cancel({ id: created.job.id, userId: 'user-a' })
  assert.equal(rejected.status, 'queued')
  assert.equal(rejected.cancelRequested, false)
  assert.equal(rejected.reconciliation.paused, false)
  assert.equal(rejected.error.code, 'AUTH_ERROR')
  assert.equal(rejected.error.retryable, false)
  const observed = await service.refresh({ id: created.job.id, userId: 'user-a' })
  assert.equal(observed.status, 'processing')
  assert.equal(observed.error, null)
  assert.doesNotMatch(JSON.stringify(rejected), /private credential detail/)
})

test('malformed successful provider responses cannot bypass terminal or bounded reconciliation', async t => {
  let statusCalls = 0
  const malformedStatusProvider = {
    name: 'malformed-status-test',
    capabilities: () => ({ operations: ['image.generate'] }),
    estimateCost: () => ({ estimatedUsd: null, currency: 'USD', basis: 'test', billable: false }),
    async submit() { return { providerJobId: 'provider-malformed-status' } },
    async getStatus() { statusCalls += 1; return null },
    async cancel(providerJobId) { return { providerJobId, state: 'cancelled' } },
    normalizeResult: value => value,
  }
  const malformedStatus = await fixture(t, { provider: malformedStatusProvider })
  const statusCreated = await malformedStatus.service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'malformed-status' })
  const failed = await malformedStatus.service.refresh({ id: statusCreated.job.id, userId: 'user-a' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'RESULT_INVALID')
  await malformedStatus.service.refresh({ id: statusCreated.job.id, userId: 'user-a' })
  assert.equal(statusCalls, 1)

  let cancelCalls = 0
  const malformedCancelProvider = {
    ...malformedStatusProvider,
    name: 'malformed-cancel-test',
    async submit() { return { providerJobId: 'provider-malformed-cancel' } },
    async getStatus(providerJobId) { return { providerJobId, state: 'queued' } },
    async cancel() { cancelCalls += 1; return null },
  }
  const malformedCancel = await fixture(t, {
    provider: malformedCancelProvider,
    serviceOptions: { maxControlPlaneErrors: 2, reconciliationBackoffMs: 0 },
  })
  const cancelCreated = await malformedCancel.service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'malformed-cancel' })
  const first = await malformedCancel.service.cancel({ id: cancelCreated.job.id, userId: 'user-a' })
  assert.equal(first.status, 'queued')
  assert.equal(first.cancelRequested, true)
  const paused = await malformedCancel.service.refresh({ id: cancelCreated.job.id, userId: 'user-a' })
  assert.equal(paused.reconciliation.paused, true)
  await malformedCancel.service.refresh({ id: cancelCreated.job.id, userId: 'user-a' })
  assert.equal(cancelCalls, 2)
})

test('job lock serializes concurrent refreshes before artifact persistence', async t => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'yeeyoo-media-lock-test-'))
  t.after(() => rm(rootPath, { recursive: true, force: true }))
  const baseStorage = createLocalDiskStorageAdapter({ rootPath })
  let writes = 0
  const storage = {
    capabilities: () => baseStorage.capabilities(),
    async put(asset) { writes += 1; return baseStorage.put(asset) },
    get: ref => baseStorage.get(ref),
    stat: ref => baseStorage.stat(ref),
  }
  const { service } = await fixture(t, { storage: storage })
  const created = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'refresh-lock' })
  const results = await Promise.all([
    service.refresh({ id: created.job.id, userId: 'user-a' }),
    service.refresh({ id: created.job.id, userId: 'user-a' }),
    service.refresh({ id: created.job.id, userId: 'user-a' }),
  ])
  assert.equal(results.at(-1).status, 'succeeded')
  assert.equal(writes, 1)
})

test('in-memory capacity is bounded and uppercase generated UUIDs are canonicalized', async t => {
  const store = createInMemoryMediaJobStore({ maxJobs: 1 })
  const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  const { service } = await fixture(t, { store, idFactory: () => uppercase })
  const first = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'bounded-1' })
  assert.equal(first.job.id, uppercase.toLowerCase())
  assert.equal((await service.getJob({ id: uppercase, userId: 'user-a' })).id, uppercase.toLowerCase())
  await assert.rejects(service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'bounded-2' }), { code: 'MEDIA_JOB_STORE_CAPACITY', status: 503 })
})

test('in-memory store evicts terminal jobs and their idempotency binding after TTL', async t => {
  let nowMs = Date.parse('2026-08-19T20:00:00.000Z')
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
  const store = createInMemoryMediaJobStore({ maxJobs: 1, terminalTtlMs: 10, clockMs: () => nowMs })
  const { service } = await fixture(t, {
    store,
    idFactory: () => ids.shift(),
    serviceOptions: { clock: () => new Date(nowMs).toISOString() },
  })
  const first = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'ttl-first' })
  await service.cancel({ id: first.job.id, userId: 'user-a' })
  nowMs += 11
  const second = await service.create({ userId: 'user-a', input: INPUT, idempotencyKey: 'ttl-second' })
  assert.equal(second.created, true)
  assert.equal(await store.count(), 1)
})
