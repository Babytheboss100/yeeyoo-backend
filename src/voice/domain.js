import crypto from 'node:crypto'

export const VOICE_SCHEMA_VERSION = 1
export const VOICE_AGENTS = Object.freeze(['tony', 'sosy'])
export const VOICE_LANGUAGES = Object.freeze(['nb-NO', 'pt-BR', 'en', 'es'])
export const VOICE_STATES = Object.freeze(['listening', 'transcribing', 'thinking', 'speaking', 'working', 'waiting_approval', 'completed', 'cancelled', 'error'])
export const DEFAULT_VOICE_LIMITS = Object.freeze({ maxAudioDurationSeconds: 90, maxAudioBytes: 8 * 1024 * 1024, maxTranscriptCharacters: 8000, maxTtsCharacters: 8000, maxCostPerTurnUsd: 0.25, maxSessionCostUsd: 2, idleTimeoutSeconds: 300 })
const languages = new Set(VOICE_LANGUAGES)
const fail = (code, message) => Object.assign(new TypeError(message), { code })
export function normalizeVoiceLanguage(value, { allowAuto = true } = {}) {
  const raw = String(value || (allowAuto ? 'AUTO' : '')).trim().replace('_', '-')
  if (allowAuto && raw.toUpperCase() === 'AUTO') return 'AUTO'
  const aliases = { nb: 'nb-NO', no: 'nb-NO', 'nb-no': 'nb-NO', pt: 'pt-BR', 'pt-br': 'pt-BR', en: 'en', es: 'es' }
  const normalized = aliases[raw.toLowerCase()] || raw
  if (!languages.has(normalized)) throw fail('VOICE_LANGUAGE_UNSUPPORTED', 'Supported languages are nb-NO, pt-BR, en and es')
  return normalized
}
const score = (text, words) => words.reduce((n, word) => n + (new RegExp(`(?:^|\\s)${word}(?:$|[\\s,.!?])`, 'iu').test(text) ? 1 : 0), 0)
export function detectVoiceLanguage(transcript) {
  const text = String(transcript || '').trim().toLowerCase()
  if (!text) return { language: null, confidence: 0, requiresClarification: true }
  const scores = { 'nb-NO': score(text, ['jeg','du','ikke','neste','uke','norsk','lage','skal','hva','hvordan']), 'pt-BR': score(text, ['você','não','para','brasil','português','crie','próxima','semana','como']), en: score(text, ['the','you','please','create','next','week','what','how','english']), es: score(text, ['usted','tú','para','español','crear','próxima','semana','qué','cómo']) }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]), [best, second] = ranked
  const confidence = best[1] === 0 ? 0 : Math.min(.99, .55 + best[1] * .1 + Math.max(0, best[1] - second[1]) * .08)
  return { language: confidence >= .65 ? best[0] : null, confidence: Number(confidence.toFixed(2)), requiresClarification: confidence < .65 }
}
export function enforceVoiceLimits(input, limits = DEFAULT_VOICE_LIMITS) {
  const applied = { ...DEFAULT_VOICE_LIMITS, ...limits }
  if (Number(input.durationSeconds || 0) > applied.maxAudioDurationSeconds) throw fail('VOICE_AUDIO_TOO_LONG', 'Audio exceeds the per-turn duration limit')
  if (Number(input.audioBytes || 0) > applied.maxAudioBytes) throw fail('VOICE_AUDIO_TOO_LARGE', 'Audio exceeds the per-turn size limit')
  if (String(input.transcript || '').length > applied.maxTranscriptCharacters) throw fail('VOICE_TRANSCRIPT_TOO_LARGE', 'Transcript exceeds the per-turn size limit')
  if (String(input.replyText || '').length > applied.maxTtsCharacters) throw fail('VOICE_TTS_TOO_LARGE', 'Spoken response exceeds the per-turn size limit')
  return applied
}
export function enforceVoiceCostLimits({ turnCostUsd = 0, sessionCostUsd = 0 }, limits = DEFAULT_VOICE_LIMITS) {
  const applied = { ...DEFAULT_VOICE_LIMITS, ...limits }, turn = Number(turnCostUsd), session = Number(sessionCostUsd)
  if (![turn, session].every(value => Number.isFinite(value) && value >= 0)) throw fail('VOICE_COST_INVALID', 'Voice costs must be non-negative numbers')
  if (turn > applied.maxCostPerTurnUsd) throw fail('VOICE_TURN_COST_CEILING_EXCEEDED', 'Voice turn cost ceiling exceeded')
  if (session + turn > applied.maxSessionCostUsd) throw fail('VOICE_SESSION_COST_CEILING_EXCEEDED', 'Voice session cost ceiling exceeded')
  return { allowed: true, projectedSessionCostUsd: session + turn }
}
export function createVoiceTurn(input, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  if (!input?.userId || !input?.projectId) throw fail('PROJECT_CONTEXT_REQUIRED', 'Voice requires authenticated project context')
  const agent = String(input.agent || '').toLowerCase(); if (!VOICE_AGENTS.includes(agent)) throw fail('VOICE_AGENT_INVALID', 'Voice agent must be Tony or Sosy')
  const transcript = String(input.transcript || '').trim(); if (!transcript) throw fail('VOICE_EMPTY_SPEECH', 'No speech was detected')
  enforceVoiceLimits({ ...input, transcript })
  const preference = normalizeVoiceLanguage(input.language || input.conversationLanguage || 'AUTO')
  const detection = preference === 'AUTO' ? detectVoiceLanguage(transcript) : { language: preference, confidence: 1, requiresClarification: false }
  return { id, schemaVersion: VOICE_SCHEMA_VERSION, sessionId: input.sessionId || crypto.randomUUID(), userId: input.userId, projectId: input.projectId, agent, source: 'voice', transcript, conversationLanguage: detection.language, outputLanguage: input.outputLanguage ? normalizeVoiceLanguage(input.outputLanguage, { allowAuto: false }) : detection.language, languageConfidence: detection.confidence, requiresLanguageClarification: detection.requiresClarification, state: detection.requiresClarification ? 'waiting_approval' : 'thinking', replyText: null, audio: null, error: null, createdAt: now, updatedAt: now }
}
export function completeVoiceTurn(turn, { replyText, audio = null, state = 'completed', now = new Date().toISOString() }) {
  if (!['completed','working','waiting_approval'].includes(state)) throw fail('VOICE_STATE_INVALID', 'Invalid completed voice state')
  enforceVoiceLimits({ transcript: turn.transcript, replyText }); return { ...turn, replyText: String(replyText || '').trim(), audio, state, updatedAt: now }
}
