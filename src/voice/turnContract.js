import { createTextToSpeechAdapter, providerLanguageCode } from './adapters.js'
import { estimateVoiceCostUsd } from './cost.js'
import { enforceVoiceCostLimits, enforceVoiceLimits, normalizeVoiceLanguage } from './domain.js'

// A voice turn returns no audio and no hosted audio URL: a URL would imply an
// object that outlives the response. The turn carries a descriptor telling the
// client whether generated speech can be streamed, and from where.
export const VOICE_SPEAK_ENDPOINT = '/api/voice/speak'
export const VOICE_TTS_FORMAT = 'mp3'
// The complete vocabulary the client understands. Anything outside this set
// would render as an unexplained failure, so every path below maps into it.
export const VOICE_TTS_UNAVAILABLE_REASONS = Object.freeze(['not_configured', 'unsupported_language', 'text_empty', 'cost_ceiling'])

export function voiceIdentityFor(agent) { return agent === 'sosy' ? 'sosy-standard' : 'tony-standard' }

// `available` is computed from what is actually configured and affordable right
// now, never assumed. An unconfigured deployment must say not_configured rather
// than promise audio that POST /voice/speak would then refuse — a truthful false
// lets the client fall back to the browser voice with a stated reason, while a
// hopeful true produces a silent reply and an error the user cannot act on.
export function describeVoiceTts({ agent = 'tony', language, replyText = '', env = process.env, createAdapter = createTextToSpeechAdapter } = {}) {
  let normalizedLanguage = null
  try { normalizedLanguage = normalizeVoiceLanguage(language, { allowAuto: false }) } catch { normalizedLanguage = null }
  const descriptor = {
    available: false,
    reason: 'not_configured',
    mode: 'stream',
    endpoint: VOICE_SPEAK_ENDPOINT,
    format: VOICE_TTS_FORMAT,
    language: normalizedLanguage || 'AUTO',
    voiceIdentity: voiceIdentityFor(agent),
  }
  // The factory fails closed when no provider is selected; a selected provider
  // with no key is equally unusable, so both collapse to not_configured.
  let adapter = null
  try { adapter = createAdapter({ env }) } catch { adapter = null }
  if (!adapter?.configured) return descriptor
  const text = String(replyText || '').trim()
  if (!text) return { ...descriptor, reason: 'text_empty' }
  if (!normalizedLanguage || !providerLanguageCode(normalizedLanguage)) return { ...descriptor, reason: 'unsupported_language' }
  try {
    // Both guards the stream endpoint applies, applied here so the client is
    // told up front instead of discovering the refusal mid-playback.
    enforceVoiceLimits({ replyText: text })
    enforceVoiceCostLimits({ turnCostUsd: estimateVoiceCostUsd({ stage: 'tts', usage: { characters: text.length, provider: adapter.provider, model: adapter.model }, env }) })
  } catch (error) {
    // An unpriced model is a configuration gap, not a spend decision. An
    // over-long reply has no reason of its own in the fixed vocabulary above;
    // it is a per-turn resource refusal, so it rides on the ceiling reason.
    return { ...descriptor, reason: error.code === 'VOICE_COST_UNPRICED' ? 'not_configured' : 'cost_ceiling' }
  }
  return { ...descriptor, available: true, reason: null }
}

// The canonical ledger stages POST /voice/turn is entitled to write. It records
// the work it actually performed and nothing else.
export function planVoiceTurnLedgerStages({ inputMode, agent = 'tony', durationSeconds = 0 } = {}) {
  const stages = []
  // A media-recorder turn was transcribed by POST /voice/transcribe, which has
  // already written voice.stt against the real provider. Writing it again here
  // would add a second, fictional row attributing the same transcription to a
  // deterministic fixture; the client derives a distinct key per stage, so the
  // unique constraint no longer hides it.
  if (inputMode !== 'media-recorder') {
    const browserSpeech = inputMode === 'browser-speech'
    stages.push({
      stage: 'stt',
      billable: false,
      usage: {
        audioSeconds: Number(durationSeconds || 0),
        provider: browserSpeech ? 'browser-speech' : 'deterministic-local',
        model: browserSpeech ? 'web-speech-api' : 'fixture-stt-v1',
      },
    })
  }
  // Orchestration is the only work this route performs. Speech synthesis is
  // billed by POST /voice/speak, when and only when it actually happens, so the
  // turn never claims a voice.tts stage it did not run.
  stages.push({ stage: 'agent', usage: { provider: 'deterministic-local', model: `${agent}-voice-orchestrator-v1` } })
  return stages
}
