import test from 'node:test'
import assert from 'node:assert/strict'
import { recordCompletedJobUsage } from '../src/jobs/jobUsage.js'
import { createWorker } from '../src/jobs/worker.js'

const job = (overrides = {}) => ({
  id: '00000000-0000-4000-8000-0000000000a1', userId: 'u1', projectId: 'p1',
  kind: 'tony', provider: 'anthropic', model: 'claude-sonnet-4-20250514', retryCount: 0,
  ...overrides,
})

test('terminal job usage has deterministic replay key and normalized token counts', async () => {
  const calls = []
  await recordCompletedJobUsage({ job: job(), usage: { tokensIn: 11, tokensOut: 7 }, recorder: async input => { calls.push(input); return { duplicate: false } } })
  await recordCompletedJobUsage({ job: job(), usage: { tokensIn: 11, tokensOut: 7 }, recorder: async input => { calls.push(input); return { duplicate: true } } })
  assert.equal(calls[0].idempotencyKey, job().id)
  assert.equal(calls[0].attempt, 1)
  assert.deepEqual([calls[0].inputTokens, calls[0].outputTokens], [11, 7])
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey)
})

test('a retry keeps the logical key and increments only the provider attempt', async () => {
  let event
  await recordCompletedJobUsage({ job: job({ retryCount: 2 }), recorder: async input => { event = input } })
  assert.equal(event.idempotencyKey, job().id)
  assert.equal(event.attempt, 3)
})

test('Tony route provider aliases normalize to canonical pricing providers', async () => {
  const expected = { claude:'anthropic', 'gpt-4o':'openai', gemini:'google', grok:'xai', deepseek:'deepseek' }
  for (const [provider, canonical] of Object.entries(expected)) {
    let event
    await recordCompletedJobUsage({ job:job({ provider }), recorder:async input => { event=input } })
    assert.equal(event.provider, canonical)
  }
})

test('offline specialist usage is explicit, zero-call and non-billable', async () => {
  let event
  await recordCompletedJobUsage({
    job: job({ kind: 'marketing.social', provider: 'deterministic-local', model: 'social-fixture-v1' }),
    usage: { providerCalls: 0, mode: 'offline-draft' }, recorder: async input => { event = input },
  })
  assert.deepEqual({ provider:event.provider, model:event.model, billable:event.billable }, { provider:'local', model:'deterministic-fixture-v1', billable:false })
  assert.equal(event.metadata.providerCalls, 0)
})

test('ledger outage cannot roll a successfully completed worker job back to failed', async () => {
  const queries = []
  const db = { async query(sql) {
    queries.push(sql)
    if (sql.includes('WITH candidate')) return { rows:[{ ...row(job()), status:'running', lease_owner:'w', input:{} }] }
    if (sql.includes("status='succeeded'")) return { rows:[{ ...row(job()), status:'succeeded', usage:{} }] }
    throw new Error(`unexpected query: ${sql}`)
  } }
  const original = console.error; console.error = () => {}
  try {
    const result = await createWorker({ workerId:'w', handlers:{ tony:async()=>({ usage:{} }) }, db, usageRecorder:async()=>{ throw Object.assign(new Error('down'),{code:'LEDGER_DOWN'}) } }).runOnce()
    assert.equal(result.job.status, 'succeeded')
    assert.equal(queries.some(sql => sql.includes('retry_count=retry_count+1')), false)
  } finally { console.error = original }
})

function row(value) {
  return { id:value.id, user_id:value.userId, project_id:value.projectId, kind:value.kind, provider:value.provider, model:value.model, retry_count:value.retryCount }
}
