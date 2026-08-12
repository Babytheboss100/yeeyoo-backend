import test from 'node:test'
import assert from 'node:assert/strict'
import { assertTransition, createJobRecord, createMockJobProvider, JobError, normalizeJobError } from '../src/jobs/jobModel.js'
import { getOwnedJob, transitionJob } from '../src/jobs/jobStore.js'
import { cancelJob, retryJob, runJob } from '../src/jobs/jobRunner.js'
test('job model requires project ownership and idempotency', () => { assert.throws(() => createJobRecord({ userId: 'u', kind: 'video', provider: 'mock', idempotencyKey: 'k' }), TypeError); const job = createJobRecord({ userId: 'u', projectId: 'p', kind: 'video', provider: 'mock', idempotencyKey: 'k', id: 'j', now: 'now' }); assert.deepEqual({ status: job.status, projectId: job.projectId, retryCount: job.retryCount }, { status: 'queued', projectId: 'p', retryCount: 0 }) })
test('job model validates timeout and retry policy', () => { assert.throws(() => createJobRecord({ userId: 'u', projectId: 'p', kind: 'video', provider: 'mock', idempotencyKey: 'k', timeoutMs: 0 }), TypeError); assert.equal(createJobRecord({ userId: 'u', projectId: 'p', kind: 'video', provider: 'mock', idempotencyKey: 'k' }).maxRetries, 2) })
test('job state machine rejects terminal replay', () => { assert.doesNotThrow(() => assertTransition('queued', 'running')); assert.throws(() => assertTransition('succeeded', 'running'), { code: 'INVALID_JOB_TRANSITION' }) })
test('provider errors are normalized without leaking details', () => { assert.deepEqual(normalizeJobError(Object.assign(new Error('secret'), { name: 'TimeoutError' })), { code: 'PROVIDER_TIMEOUT', message: 'Provider timed out', retryable: true }); assert.deepEqual(normalizeJobError(new JobError('UNAVAILABLE', 'Provider unavailable')), { code: 'UNAVAILABLE', message: 'Provider unavailable', retryable: false }) })
test('offline mock provider satisfies provider contract', async () => { const result = await createMockJobProvider({ result: { artifacts: [] } }).submit({ id: 'j' }); assert.equal(result.state, 'succeeded'); assert.equal(result.providerJobId, 'mock:j') })
test('durable job reads require user and project together', async () => {
  let params
  const db = { async query(_sql, values) { params = values; return { rows: [] } } }
  assert.equal(await getOwnedJob({ id: 'j', userId: 'u', projectId: 'p', db }), null)
  assert.deepEqual(params, ['j', 'u', 'p'])
})
test('durable transition is atomic and project scoped', async () => {
  let query
  const db = { async query(sql, values) { query = { sql, values }; return { rows: [] } } }
  assert.equal(await transitionJob({ id: 'j', userId: 'u', projectId: 'p', from: 'running', to: 'failed', error: new Error('provider secret'), db }), null)
  assert.match(query.sql, /user_id=\$8 AND project_id=\$9 AND status=\$6/)
  assert.deepEqual(query.values.slice(-3), ['j', 'u', 'p'])
  assert.doesNotMatch(query.values[4], /provider secret/)
})
test('runner rejects invalid state and retry/cancel enforce lifecycle', async () => {
  await assert.rejects(runJob({ job: { status: 'running' }, provider: createMockJobProvider() }), { code: 'INVALID_JOB_STATE' })
  await assert.rejects(retryJob({ job: { status: 'failed', retryCount: 2, maxRetries: 2 } }), { code: 'RETRY_LIMIT' })
  await assert.rejects(cancelJob({ job: { status: 'succeeded' } }), { code: 'INVALID_JOB_STATE' })
})
