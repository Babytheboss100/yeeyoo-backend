import { recordAIUsage } from '../services/aiUsageLedger.js'
export async function recordVoiceUsage({ turn, stage, usage = {}, idempotencyKey, status = 'succeeded', billable = false }, options = {}) {
  if (!['stt','agent','tts'].includes(stage)) throw Object.assign(new TypeError('Invalid voice cost stage'), { code: 'VOICE_COST_STAGE_INVALID' })
  const mediaUnits = stage === 'stt' ? Number(usage.audioSeconds || 0) : stage === 'tts' ? Number(usage.characters || 0) : 0
  return recordAIUsage({ userId: turn.userId, projectId: turn.projectId, specialist: turn.agent, operation: `voice.${stage}`, provider: usage.provider || 'deterministic-local', model: usage.model || `voice-${stage}-v1`, idempotencyKey: idempotencyKey || `${turn.id}:${stage}`, attempt: 1, status, billable, mediaUnits, mediaUnitType: stage === 'stt' ? 'audio_seconds' : stage === 'tts' ? 'characters' : null, inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, metadata: { voiceTurnId: turn.id, voiceSessionId: turn.sessionId, agent: turn.agent, stage } }, options)
}
