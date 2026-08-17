import test from 'node:test'
import assert from 'node:assert/strict'
import { DETERMINISTIC_VOICE_PROVIDER, VOICE_MEDIA_PRICING, estimateVoiceCostUsd, recordVoiceUsage, voicePricingTable } from '../src/voice/cost.js'
import { calculateModelCost } from '../src/lib/aiPricing.js'
import { DEFAULT_VOICE_LIMITS, enforceVoiceCostLimits } from '../src/voice/domain.js'

// Offline ledger stub: captures the canonical INSERT parameters so we can assert
// the exact row shape without touching any database.
const COLUMNS = ['id', 'user_id', 'project_id', 'campaign_id', 'plan_id', 'plan_step_id', 'job_id', 'specialist', 'operation',
  'provider', 'model', 'idempotency_key', 'attempt', 'status', 'input_tokens', 'output_tokens', 'cached_input_tokens',
  'media_units', 'media_unit_type', 'cost_usd', 'estimated_cost_usd', 'provider_cost_usd', 'cost_source', 'billable',
  'retry_of', 'pricing_version', 'metadata']

function ledgerStub() {
  const rows = []
  return {
    rows,
    db: { query: async (sql, values) => { rows.push(Object.fromEntries(COLUMNS.map((name, index) => [name, values[index]]))); return { rows: [rows.at(-1)] } } },
  }
}
const turn = { id: 'voice-turn-1', sessionId: 'voice-session-1', userId: 'user-1', projectId: 'project-1', agent: 'tony' }
const env = { AI_MODEL_PRICING_JSON: '' }

test('voice.stt, voice.agent and voice.tts are three separate replay-safe ledger entries', async () => {
  const { rows, db } = ledgerStub()
  for (const stage of ['stt', 'agent', 'tts']) {
    await recordVoiceUsage({ turn, stage, idempotencyKey: `req-42:${stage}`, usage: stage === 'stt' ? { audioSeconds: 4 } : stage === 'tts' ? { characters: 120 } : {} }, { db, env })
  }
  assert.deepEqual(rows.map(row => row.operation), ['voice.stt', 'voice.agent', 'voice.tts'])
  assert.deepEqual(rows.map(row => row.idempotency_key), ['req-42:stt', 'req-42:agent', 'req-42:tts'])
  assert.deepEqual(rows.map(row => row.media_unit_type), ['audio_seconds', null, 'characters'])
  assert.deepEqual(rows.map(row => row.media_units), [4, 0, 120])
  assert.ok(rows.every(row => row.user_id === 'user-1' && row.project_id === 'project-1' && row.specialist === 'tony'))
  assert.ok(rows.every(row => JSON.parse(row.metadata).voiceTurnId === 'voice-turn-1'))
  // Voice never rides on any ads/spend operation namespace.
  assert.ok(rows.every(row => row.operation.startsWith('voice.')))
})

test('deterministic fixture usage stays explicitly zero-cost and non-billable', async () => {
  const { rows, db } = ledgerStub()
  for (const stage of ['stt', 'agent', 'tts']) {
    await recordVoiceUsage({ turn, stage, idempotencyKey: `fixture:${stage}`, usage: { provider: DETERMINISTIC_VOICE_PROVIDER, model: `fixture-${stage}-v1`, audioSeconds: 9, characters: 400 } }, { db, env })
  }
  assert.ok(rows.every(row => row.billable === false), 'fixtures must never be billable')
  assert.ok(rows.every(row => Number(row.cost_usd) === 0 && Number(row.estimated_cost_usd) === 0))
  assert.ok(rows.every(row => row.cost_source === 'non_billable' && row.pricing_version === 'non-billable-v1'))
  assert.ok(rows.every(row => row.provider === DETERMINISTIC_VOICE_PROVIDER))
})

test('real provider voice work is billed from real usage', async () => {
  const { rows, db } = ledgerStub()
  await recordVoiceUsage({ turn, stage: 'stt', idempotencyKey: 'real:stt', usage: { provider: 'openai', model: 'gpt-4o-mini-transcribe', audioSeconds: 6 } }, { db, env })
  await recordVoiceUsage({ turn, stage: 'tts', idempotencyKey: 'real:tts', usage: { provider: 'openai', model: 'gpt-4o-mini-tts', characters: 200 } }, { db, env })
  const [stt, tts] = rows
  assert.equal(stt.billable, true)
  assert.equal(stt.cost_source, 'estimated')
  assert.equal(Number(stt.cost_usd), Number((6 * VOICE_MEDIA_PRICING['openai/gpt-4o-mini-transcribe'].perAudioSecond).toFixed(8)))
  assert.ok(Number(stt.cost_usd) > 0, 'real speech-to-text must cost more than zero')
  assert.equal(tts.billable, true)
  assert.equal(Number(tts.cost_usd), (200 * VOICE_MEDIA_PRICING['openai/gpt-4o-mini-tts'].perMillionCharacters) / 1_000_000)
  assert.ok(Number(tts.cost_usd) > 0, 'real speech synthesis must cost more than zero')
})

test('failed real provider attempts are recorded but not billed', async () => {
  const { rows, db } = ledgerStub()
  await recordVoiceUsage({ turn, stage: 'stt', status: 'failed', idempotencyKey: 'real:fail', usage: { provider: 'openai', model: 'gpt-4o-mini-transcribe', audioSeconds: 3 } }, { db, env })
  assert.equal(rows[0].status, 'failed')
  assert.equal(rows[0].billable, false)
  assert.equal(Number(rows[0].cost_usd), 0)
})

test('configured pricing wins over the voice media fallback rate card', () => {
  const configured = voicePricingTable({ AI_MODEL_PRICING_JSON: JSON.stringify({ version: 'owner-v9', models: { 'openai/gpt-4o-mini-transcribe': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perAudioSecond: 0.001 } } }) })
  assert.equal(configured.version, 'owner-v9')
  assert.equal(configured.models['openai/gpt-4o-mini-transcribe'].perAudioSecond, 0.001)
  assert.ok(configured.models['openai/gpt-4o-mini-tts'], 'unconfigured voice models still resolve')
  assert.equal(voicePricingTable({ AI_MODEL_PRICING_JSON: '' }).version, 'voice-media-v1')
})

test('media pricing is additive and leaves token-priced models untouched', () => {
  const table = voicePricingTable({ AI_MODEL_PRICING_JSON: '' })
  assert.equal(calculateModelCost({ provider: 'openai', model: 'gpt-4o-mini-transcribe', mediaUnits: 60, mediaUnitType: 'audio_seconds', table }).costUsd, 0.003)
  assert.equal(calculateModelCost({ provider: 'openai', model: 'gpt-4o-mini-transcribe', mediaUnits: 60, mediaUnitType: null, table }).costUsd, 0)
  const tokenTable = { version: 'token-v1', models: { 'mock/tiny': { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0 } } }
  assert.equal(calculateModelCost({ provider: 'mock', model: 'tiny', inputTokens: 1000, mediaUnits: 500, mediaUnitType: 'audio_seconds', table: tokenTable }).costUsd, 0.001)
})

test('invalid voice cost stages fail closed', async () => {
  const { db } = ledgerStub()
  await assert.rejects(recordVoiceUsage({ turn, stage: 'publish', idempotencyKey: 'x' }, { db, env }), error => error.code === 'VOICE_COST_STAGE_INVALID')
})

test('pre-flight estimate matches what is later billed and fails closed when unpriced', () => {
  const usage = { characters: 200, provider: 'openai', model: 'gpt-4o-mini-tts' }
  assert.equal(estimateVoiceCostUsd({ stage: 'tts', usage, env }), 0.003)
  assert.equal(estimateVoiceCostUsd({ stage: 'stt', usage: { audioSeconds: 60, provider: 'openai', model: 'gpt-4o-mini-transcribe' }, env }), 0.003)
  // Fixtures are free by construction, so they never consult a rate card.
  assert.equal(estimateVoiceCostUsd({ stage: 'tts', usage: { characters: 5000 }, env }), 0)
  assert.throws(() => estimateVoiceCostUsd({ stage: 'tts', usage: { characters: 10, provider: 'openai', model: 'some-unlisted-model' }, env }), error => error.code === 'VOICE_COST_UNPRICED')
})

test('an oversized reply is refused by the per-turn ceiling before the provider is called', () => {
  const characters = 8000
  const estimate = estimateVoiceCostUsd({ stage: 'tts', usage: { characters, provider: 'openai', model: 'gpt-4o-mini-tts' }, env })
  assert.ok(estimate < DEFAULT_VOICE_LIMITS.maxCostPerTurnUsd, 'a maximum-length reply must stay inside the per-turn ceiling')
  assert.throws(() => enforceVoiceCostLimits({ turnCostUsd: DEFAULT_VOICE_LIMITS.maxCostPerTurnUsd + 0.01 }), error => error.code === 'VOICE_TURN_COST_CEILING_EXCEEDED')
})

test('browser-speech transcription is attributed truthfully and stays free', async () => {
  const { rows, db } = ledgerStub()
  await recordVoiceUsage({ turn, stage: 'stt', idempotencyKey: 'browser:stt', billable: false, usage: { audioSeconds: 5, provider: 'browser-speech', model: 'web-speech-api' } }, { db, env })
  assert.equal(rows[0].provider, 'browser-speech')
  assert.equal(rows[0].billable, false)
  assert.equal(Number(rows[0].cost_usd), 0)
  assert.equal(rows[0].cost_source, 'non_billable')
})
