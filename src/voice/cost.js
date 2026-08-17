import { recordAIUsage } from '../services/aiUsageLedger.js'
import { loadPricingTable } from '../lib/aiPricing.js'

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

export async function recordVoiceUsage({ turn, stage, usage = {}, idempotencyKey, status = 'succeeded', billable }, options = {}) {
  if (!['stt', 'agent', 'tts'].includes(stage)) throw Object.assign(new TypeError('Invalid voice cost stage'), { code: 'VOICE_COST_STAGE_INVALID' })
  const provider = usage.provider || DETERMINISTIC_VOICE_PROVIDER
  // Deterministic fixtures are explicitly non-billable and zero-cost; only real
  // provider work is billed, and only when it actually succeeded.
  const billed = billable ?? (provider !== DETERMINISTIC_VOICE_PROVIDER && status === 'succeeded')
  const mediaUnits = stage === 'stt' ? Number(usage.audioSeconds || 0) : stage === 'tts' ? Number(usage.characters || 0) : 0
  const { env, ...ledgerOptions } = options
  return recordAIUsage({ userId: turn.userId, projectId: turn.projectId, specialist: turn.agent, operation: `voice.${stage}`, provider, model: usage.model || `voice-${stage}-v1`, idempotencyKey: idempotencyKey || `${turn.id}:${stage}`, attempt: 1, status, billable: billed, mediaUnits, mediaUnitType: stage === 'stt' ? 'audio_seconds' : stage === 'tts' ? 'characters' : null, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, providerCostUsd: usage.providerCostUsd, metadata: { voiceTurnId: turn.id, voiceSessionId: turn.sessionId, agent: turn.agent, stage } }, { pricingTable: voicePricingTable(env), ...ledgerOptions })
}
