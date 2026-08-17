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

// ─── Real provider boundary ──────────────────────────────────────────────────
// Everything below keeps the vendor behind a neutral interface: user-facing
// error messages and result shapes never name the provider. Only `provider`
// metadata (internal, for the canonical AI cost ledger) carries the vendor id.
const PROVIDER_BASE_URL = 'https://api.openai.com/v1'
// Canonical voice languages -> provider ISO-639-1 codes. Norwegian Bokmål is
// 'no' at the provider, NOT 'nb'; a naive split('-')[0] silently degrades it.
const PROVIDER_LANGUAGE_CODES = Object.freeze({ 'nb-NO': 'no', 'pt-BR': 'pt', en: 'en', es: 'es' })
const AUDIO_EXTENSIONS = Object.freeze({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac' })
const TTS_FORMAT_MIME = Object.freeze({ mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' })
// App-level voice identities -> provider voice names. Callers never learn these.
const PROVIDER_VOICES = Object.freeze({ 'tony-standard': 'alloy', 'sosy-standard': 'shimmer' })

export function providerLanguageCode(language) {
  const normalized = normalizeVoiceLanguage(language)
  return normalized === 'AUTO' ? null : PROVIDER_LANGUAGE_CODES[normalized]
}

// Distinguishes caller cancellation from our own deadline so the typed error is
// truthful, and unregisters the listener so no reference outlives the request.
function deadline(signal, timeoutMs) {
  const controller = new AbortController()
  const scope = { timedOut: false, signal: controller.signal }
  const timer = setTimeout(() => { scope.timedOut = true; controller.abort() }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  scope.release = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  return scope
}
const isAbort = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
// Never read a failed provider body into an error: drop it so the socket is
// released without provider detail ever entering our process as a message.
const discardBody = async response => { try { await response?.body?.cancel?.() } catch { /* already released */ } }

export class OpenAISpeechToTextAdapter {
  // baseUrl is deliberately constructor-only and never read from env: an
  // env-settable endpoint would turn a config mistake into audio exfiltration.
  constructor({ apiKey, model = 'gpt-4o-mini-transcribe', fetchImpl = globalThis.fetch, timeoutMs = 30000, baseUrl = PROVIDER_BASE_URL } = {}) {
    this.provider = 'openai'; this.model = String(model || 'gpt-4o-mini-transcribe'); this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.timeoutMs = Number(timeoutMs) || 30000; this.baseUrl = baseUrl
  }
  async transcribe({ audio, mimeType = 'audio/webm', languageHint = 'AUTO', durationSeconds = 0, signal } = {}) {
    if (!this.apiKey) throw failure('VOICE_STT_NOT_CONFIGURED', 'Real speech transcription is not configured')
    if (signal?.aborted) throw failure('VOICE_CANCELLED', 'Transcription cancelled')
    if (!Buffer.isBuffer(audio) || !audio.length) throw failure('VOICE_AUDIO_EMPTY', 'Recorded audio is empty')
    const seconds = Number(durationSeconds || 0)
    if (!Number.isFinite(seconds) || seconds < 0) throw failure('VOICE_AUDIO_DURATION_INVALID', 'Recorded audio duration is invalid')
    enforceVoiceLimits({ durationSeconds: seconds, audioBytes: audio.byteLength })
    const normalized = normalizeVoiceLanguage(languageHint)
    const scope = deadline(signal, this.timeoutMs)
    // Kept in `let` so the finally block can drop the provider-side copy of the
    // audio as soon as the request settles, on every path.
    let blob = new Blob([audio], { type: mimeType }), form = new FormData()
    try {
      form.append('file', blob, `voice.${AUDIO_EXTENSIONS[mimeType] || 'webm'}`)
      form.append('model', this.model)
      form.append('response_format', 'json')
      const code = providerLanguageCode(normalized)
      if (code) form.append('language', code)
      const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: scope.signal })
      if (!response.ok) { await discardBody(response); throw failure('VOICE_STT_PROVIDER_FAILED', 'Speech transcription failed') }
      const payload = await response.json().catch(() => ({}))
      const transcript = String(payload.text || '').trim()
      if (!transcript) throw failure('VOICE_NO_SPEECH', 'No speech was detected in the recording')
      enforceVoiceLimits({ transcript })
      const detected = normalized === 'AUTO' ? detectVoiceLanguage(transcript) : { language: normalized, confidence: 1 }
      return { transcript, detectedLanguage: detected.language, confidence: detected.confidence, durationSeconds: seconds, provider: this.provider, model: this.model, usage: { audioSeconds: seconds }, streaming: false, error: null }
    } catch (error) {
      if (isAbort(error)) throw scope.timedOut ? failure('VOICE_STT_TIMEOUT', 'Speech transcription timed out') : failure('VOICE_CANCELLED', 'Transcription cancelled')
      if (error?.code) throw error
      throw failure('VOICE_STT_PROVIDER_FAILED', 'Speech transcription failed')
    } finally { scope.release(); form = null; blob = null }
  }
}

export class OpenAITextToSpeechAdapter {
  // baseUrl is constructor-only and never env-derived; see the STT adapter.
  constructor({ apiKey, model = 'gpt-4o-mini-tts', fetchImpl = globalThis.fetch, timeoutMs = 30000, baseUrl = PROVIDER_BASE_URL } = {}) {
    this.provider = 'openai'; this.model = String(model || 'gpt-4o-mini-tts'); this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.timeoutMs = Number(timeoutMs) || 30000; this.baseUrl = baseUrl; this.streaming = false
  }
  async synthesize({ text, language, voiceIdentity = 'tony-standard', audioFormat = 'mp3', signal } = {}) {
    if (!this.apiKey) throw failure('VOICE_TTS_NOT_CONFIGURED', 'Real speech synthesis is not configured')
    if (signal?.aborted) throw failure('VOICE_CANCELLED', 'Speech synthesis cancelled')
    const normalizedText = String(text || '').trim()
    if (!normalizedText) throw failure('VOICE_TTS_EMPTY', 'Text-to-speech requires text')
    enforceVoiceLimits({ replyText: normalizedText })
    const normalizedLanguage = normalizeVoiceLanguage(language, { allowAuto: false })
    const format = String(audioFormat || 'mp3').toLowerCase()
    if (!TTS_FORMAT_MIME[format]) throw failure('VOICE_TTS_FORMAT_UNSUPPORTED', 'Requested audio format is not supported')
    const voice = PROVIDER_VOICES[voiceIdentity]
    if (!voice) throw failure('VOICE_TTS_IDENTITY_UNSUPPORTED', 'Requested voice identity is not supported')
    const scope = deadline(signal, this.timeoutMs)
    const body = { model: this.model, input: normalizedText, voice, response_format: format }
    if (this.model.includes('gpt-4o')) body.instructions = `Speak naturally as a native ${normalizedLanguage} speaker.`
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: scope.signal })
      if (!response.ok) { await discardBody(response); throw failure('VOICE_TTS_PROVIDER_FAILED', 'Speech synthesis failed') }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw failure('VOICE_TTS_NO_AUDIO', 'Speech synthesis returned no audio')
      // Bytes are handed to the caller in memory only. audioLifecycle
      // (withEphemeralSynthesis / releaseSynthesizedAudio) zeroes them; nothing
      // here writes to disk or database.
      return { audio: { kind: 'bytes', bytes, format, mimeType: TTS_FORMAT_MIME[format], contentType: response.headers?.get?.('content-type') || TTS_FORMAT_MIME[format], byteLength: bytes.length, ephemeral: true, persisted: false }, language: normalizedLanguage, voiceIdentity, provider: this.provider, model: this.model, usage: { characters: normalizedText.length }, streaming: false, error: null }
    } catch (error) {
      if (isAbort(error)) throw scope.timedOut ? failure('VOICE_TTS_TIMEOUT', 'Speech synthesis timed out') : failure('VOICE_CANCELLED', 'Speech synthesis cancelled')
      if (error?.code) throw error
      throw failure('VOICE_TTS_PROVIDER_FAILED', 'Speech synthesis failed')
    } finally { scope.release() }
  }
}

export function createSpeechToTextAdapter({ env = process.env, ...options } = {}) {
  if (env.VOICE_STT_PROVIDER === 'openai') return new OpenAISpeechToTextAdapter({ apiKey: env.OPENAI_API_KEY, model: env.VOICE_STT_MODEL || undefined, ...options })
  throw failure('VOICE_STT_NOT_CONFIGURED', 'Real speech transcription is not configured')
}

export function createTextToSpeechAdapter({ env = process.env, ...options } = {}) {
  if (env.VOICE_TTS_PROVIDER === 'openai') return new OpenAITextToSpeechAdapter({ apiKey: env.OPENAI_API_KEY, model: env.VOICE_TTS_MODEL || undefined, ...options })
  throw failure('VOICE_TTS_NOT_CONFIGURED', 'Real speech synthesis is not configured')
}
