import { recordAIUsage } from '../services/aiUsageLedger.js'
import { calculateModelCost, loadPricingTable } from '../lib/aiPricing.js'

export const DETERMINISTIC_VOICE_PROVIDER = 'deterministic-local'

// Media rate card for voice models. Voice is billed per audio second (STT) and
// per character (TTS), not per token, so these rates carry the media fields the
// canonical pricing table understands. A configured AI_MODEL_PRICING_JSON entry
// always wins; these only fill gaps so a real voice turn can never fail closed
// on a missing price after the provider has already been paid.
export const VOICE_MEDIA_PRICING = Object.freeze({
  'openai/gpt-4o-mini-transcribe': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perAudioSecond: 0.00005 },
  'openai/gpt-4o-transcribe': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perAudioSecond: 0.0001 },
  'openai/whisper-1': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perAudioSecond: 0.0001 },
  'openai/gpt-4o-mini-tts': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perMillionCharacters: 15 },
  'openai/tts-1': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perMillionCharacters: 15 },
})

export function voicePricingTable(env = process.env) {
  let base
  try { base = loadPricingTable(env) } catch { base = { version: 'voice-media-v1', models: {} } }
  return { version: base.version, models: { ...VOICE_MEDIA_PRICING, ...base.models } }
}

const mediaUnitTypeFor = stage => (stage === 'stt' ? 'audio_seconds' : stage === 'tts' ? 'characters' : null)
const mediaUnitsFor = (stage, usage) => (stage === 'stt' ? Number(usage.audioSeconds || 0) : stage === 'tts' ? Number(usage.characters || 0) : 0)

// Pre-flight estimate so a turn can be refused against the canonical voice cost
// ceilings before the provider is paid. Fixtures are free by construction; an
// unpriced real model fails closed rather than being silently estimated at zero.
export function estimateVoiceCostUsd({ stage, usage = {}, env = process.env }) {
  const provider = usage.provider || DETERMINISTIC_VOICE_PROVIDER
  if (provider === DETERMINISTIC_VOICE_PROVIDER) return 0
  try {
    return calculateModelCost({ provider, model: usage.model, mediaUnits: mediaUnitsFor(stage, usage), mediaUnitType: mediaUnitTypeFor(stage), table: voicePricingTable(env) }).costUsd
  } catch {
    throw Object.assign(new Error('Voice work has no configured price'), { code: 'VOICE_COST_UNPRICED' })
  }
}

export async function recordVoiceUsage({ turn, stage, usage = {}, idempotencyKey, status = 'succeeded', billable }, options = {}) {
  if (!['stt', 'agent', 'tts'].includes(stage)) throw Object.assign(new TypeError('Invalid voice cost stage'), { code: 'VOICE_COST_STAGE_INVALID' })
  const provider = usage.provider || DETERMINISTIC_VOICE_PROVIDER
  // Deterministic fixtures are explicitly non-billable and zero-cost; only real
  // provider work is billed, and only when it actually succeeded.
  const billed = billable ?? (provider !== DETERMINISTIC_VOICE_PROVIDER && status === 'succeeded')
  const mediaUnits = mediaUnitsFor(stage, usage)
  const { env, ...ledgerOptions } = options
  return recordAIUsage({ userId: turn.userId, projectId: turn.projectId, specialist: turn.agent, operation: `voice.${stage}`, provider, model: usage.model || `voice-${stage}-v1`, idempotencyKey: idempotencyKey || `${turn.id}:${stage}`, attempt: 1, status, billable: billed, mediaUnits, mediaUnitType: mediaUnitTypeFor(stage), inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, providerCostUsd: usage.providerCostUsd, metadata: { voiceTurnId: turn.id, voiceSessionId: turn.sessionId, agent: turn.agent, stage } }, { pricingTable: voicePricingTable(env), ...ledgerOptions })
}
