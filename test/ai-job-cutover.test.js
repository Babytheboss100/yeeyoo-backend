import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_JOB_KINDS, getJobPolicy, legacyStatus, normalizeArtifacts } from '../src/jobs/jobKinds.js'
import { beginDurableJob } from '../src/jobs/jobCutover.js'

test('all cutover kinds have bounded timeout and retry policy', () => {
  for (const kind of Object.values(AI_JOB_KINDS)) { const p = getJobPolicy(kind); assert.ok(p.timeoutMs <= 120_000); assert.ok(p.maxRetries <= 2) }
})
test('durable cutover requires a project and preserves idempotency', async () => {
  await assert.rejects(beginDurableJob({ userId: 'u', kind: 'video', provider: 'mock', db: {} }), TypeError)
  let values
  const db = { async query(_sql, params) { values = params; return { rows: [{ id: 'j', user_id: 'u', project_id: 'p', kind: 'video', provider: 'mock', status: 'queued', idempotency_key: 'same', input: {}, artifacts: [], usage: {}, retry_count: 0, max_retries: 2, timeout_ms: 120000 }] } } }
  const job = await beginDurableJob({ userId: 'u', projectId: 'p', kind: 'video', provider: 'mock', input: {}, idempotencyKey: 'same', db })
  assert.equal(job.idempotencyKey, 'same'); assert.equal(values[6], 'same')
})
test('legacy status and artifacts preserve frontend contracts', () => {
  assert.equal(legacyStatus('succeeded'), 'completed')
  assert.deepEqual(normalizeArtifacts('video', { videoUrl: 'https://example.invalid/v.mp4' }), [{ type: 'video', url: 'https://example.invalid/v.mp4' }])
  assert.equal(normalizeArtifacts('translate_image', { detectedText: 'Hi', translatedText: 'Hei' })[0].type, 'translation')
})
