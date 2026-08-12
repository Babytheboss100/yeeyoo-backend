import test from 'node:test'
import assert from 'node:assert/strict'
import { beginPublishAttempt, finishPublishAttempt } from '../src/lib/publishAttempt.js'

test('publish attempt returns existing durable result for duplicate idempotency key', async () => {
  let calls = 0
  const db = { query: async (sql) => {
    calls++
    if (sql.includes('INSERT INTO')) return { rows: [] }
    return { rows: [{ id: 'attempt-1', status: 'completed', provider_result: { id: 'post-1' } }] }
  } }
  const value = await beginPublishAttempt({ userId: 'u', projectId: 'p', accountId: 'a', platform: 'facebook', idempotencyKey: 'same' }, db)
  assert.equal(value.duplicate, true)
  assert.equal(value.attempt.provider_result.id, 'post-1')
  assert.equal(calls, 2)
})

test('publish attempt persists normalized terminal failure', async () => {
  let params
  await finishPublishAttempt('attempt-1', { status: 'failed', error: { code: 'timeout', message: 'timed out' } }, { query: async (_sql, values) => { params = values; return { rows: [] } } })
  assert.deepEqual(params.slice(0, 2), ['attempt-1', 'failed'])
  assert.equal(params[3], 'timeout')
})
