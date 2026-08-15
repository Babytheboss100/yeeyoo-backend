import crypto from 'node:crypto'
import { detectVoiceLanguage, enforceVoiceLimits, normalizeVoiceLanguage } from './domain.js'
const failure = (code, message) => Object.assign(new Error(message), { code })
export class DeterministicSpeechToTextAdapter {
  constructor({ fixtures = {} } = {}) { this.provider = 'deterministic-local'; this.model = 'fixture-stt-v1'; this.fixtures = fixtures }
  async transcribe({ audio, fixtureId, languageHint = 'AUTO', durationSeconds = 0, signal } = {}) {
    if (signal?.aborted) throw failure('VOICE_CANCELLED', 'Transcription cancelled')
    const fixture = this.fixtures[fixtureId] || (audio && typeof audio === 'object' && !Buffer.isBuffer(audio) ? audio : null)
    if (!fixture?.transcript) throw failure('VOICE_FIXTURE_NOT_FOUND', 'Deterministic STT requires a registered audio fixture')
    enforceVoiceLimits({ durationSeconds, audioBytes: Buffer.isBuffer(audio) ? audio.byteLength : 0, transcript: fixture.transcript })
    const hint = normalizeVoiceLanguage(languageHint)
    const detected = hint === 'AUTO' ? detectVoiceLanguage(fixture.transcript) : { language: hint, confidence: 1 }
    return { transcript: fixture.transcript, detectedLanguage: fixture.language || detected.language, confidence: fixture.confidence ?? detected.confidence, durationSeconds, provider: this.provider, model: this.model, usage: { audioSeconds: durationSeconds }, streaming: false, error: null }
  }
}
export class DeterministicTextToSpeechAdapter {
  constructor() { this.provider = 'deterministic-local'; this.model = 'fixture-tts-v1'; this.streaming = false }
  async synthesize({ text, language, voiceIdentity = 'tony-standard', audioFormat = 'wav', signal } = {}) {
    if (signal?.aborted) throw failure('VOICE_CANCELLED', 'Speech synthesis cancelled')
    const normalizedText = String(text || '').trim(); if (!normalizedText) throw failure('VOICE_TTS_EMPTY', 'Text-to-speech requires text')
    enforceVoiceLimits({ replyText: normalizedText })
    const normalizedLanguage = normalizeVoiceLanguage(language, { allowAuto: false })
    const id = crypto.createHash('sha256').update(`${voiceIdentity}:${normalizedLanguage}:${normalizedText}`).digest('hex').slice(0, 16)
    return { audio: { kind: 'fixture', id: `tts-${id}`, format: audioFormat, ephemeral: true }, language: normalizedLanguage, voiceIdentity, provider: this.provider, model: this.model, usage: { characters: normalizedText.length }, streaming: false, error: null }
  }
}
export function createDeterministicVoiceAdapters(options = {}) { return { stt: new DeterministicSpeechToTextAdapter(options), tts: new DeterministicTextToSpeechAdapter() } }
