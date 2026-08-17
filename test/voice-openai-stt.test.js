import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { OpenAISpeechToTextAdapter, createSpeechToTextAdapter, providerLanguageCode } from '../src/voice/adapters.js'
import { withEphemeralAudio } from '../src/voice/audioLifecycle.js'

// Every test here is offline: fetchImpl is always a stub, never a real socket.
const okJson = text => async (url, options) => ({ ok: true, json: async () => ({ text }), _url: url, _options: options })
const adapter = (fetchImpl, options = {}) => new OpenAISpeechToTextAdapter({ apiKey: 'test-only', fetchImpl, ...options })
const audio = () => Buffer.from('synthetic-audio-payload')

test('OpenAI STT sends multipart audio and normalizes Norwegian transcript', async () => {
  let request
  const stt = adapter(async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ text: 'Hvordan går markedsføringen vår?' }) } })
  const result = await stt.transcribe({ audio: audio(), mimeType: 'audio/webm', languageHint: 'nb-NO', durationSeconds: 2 })
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(request.options.headers.Authorization, 'Bearer test-only')
  assert.equal(request.options.body.get('model'), 'gpt-4o-mini-transcribe')
  assert.equal(request.options.body.get('file').name, 'voice.webm')
  assert.equal(result.transcript, 'Hvordan går markedsføringen vår?')
  assert.equal(result.detectedLanguage, 'nb-NO')
  assert.equal(result.provider, 'openai')
  assert.deepEqual(result.usage, { audioSeconds: 2 })
})

test('language hints map to provider codes and AUTO defers to detection', async () => {
  assert.deepEqual(['nb-NO', 'pt-BR', 'en', 'es'].map(providerLanguageCode), ['no', 'pt', 'en', 'es'])
  assert.equal(providerLanguageCode('AUTO'), null)
  for (const [hint, expected] of [['nb-NO', 'no'], ['pt-BR', 'pt'], ['en', 'en'], ['es', 'es'], ['nb', 'no'], ['pt', 'pt']]) {
    let sent
    const stt = adapter(async (url, options) => { sent = options.body.get('language'); return { ok: true, json: async () => ({ text: 'ok' }) } })
    await stt.transcribe({ audio: audio(), languageHint: hint })
    assert.equal(sent, expected, hint)
  }
  let autoSent = 'unset'
  const auto = adapter(async (url, options) => { autoSent = options.body.get('language'); return { ok: true, json: async () => ({ text: 'Crie uma campanha para você na próxima semana' }) } })
  const detected = await auto.transcribe({ audio: audio(), languageHint: 'AUTO' })
  assert.equal(autoSent, null, 'AUTO must not pin a provider language')
  assert.equal(detected.detectedLanguage, 'pt-BR')
})

test('unsupported language fails closed before the provider is called', async () => {
  let called = false
  const stt = adapter(async () => { called = true; return { ok: true, json: async () => ({ text: 'x' }) } })
  await assert.rejects(stt.transcribe({ audio: audio(), languageHint: 'de-DE' }), error => error.code === 'VOICE_LANGUAGE_UNSUPPORTED')
  assert.equal(called, false)
})

test('real STT factory fails closed unless explicitly configured', () => {
  assert.throws(() => createSpeechToTextAdapter({ env: {} }), error => error.code === 'VOICE_STT_NOT_CONFIGURED')
  assert.throws(() => createSpeechToTextAdapter({ env: { OPENAI_API_KEY: 'test' } }), error => error.code === 'VOICE_STT_NOT_CONFIGURED')
  const configured = createSpeechToTextAdapter({ env: { VOICE_STT_PROVIDER: 'openai', OPENAI_API_KEY: 'test' } })
  assert.equal(configured.provider, 'openai')
  assert.equal(configured.model, 'gpt-4o-mini-transcribe')
  assert.equal(createSpeechToTextAdapter({ env: { VOICE_STT_PROVIDER: 'openai', OPENAI_API_KEY: 'test', VOICE_STT_MODEL: 'gpt-4o-transcribe' } }).model, 'gpt-4o-transcribe')
})

test('missing key fails closed without reaching the network', async () => {
  let called = false
  const stt = new OpenAISpeechToTextAdapter({ apiKey: '', fetchImpl: async () => { called = true } })
  await assert.rejects(stt.transcribe({ audio: audio() }), error => error.code === 'VOICE_STT_NOT_CONFIGURED')
  assert.equal(called, false)
})

test('empty audio and silent recordings return truthful typed errors', async () => {
  await assert.rejects(adapter(okJson('x')).transcribe({ audio: Buffer.alloc(0) }), error => error.code === 'VOICE_AUDIO_EMPTY')
  await assert.rejects(adapter(okJson('x')).transcribe({ audio: null }), error => error.code === 'VOICE_AUDIO_EMPTY')
  await assert.rejects(adapter(okJson('   ')).transcribe({ audio: audio() }), error => error.code === 'VOICE_NO_SPEECH')
})

test('oversized audio is rejected by canonical voice limits', async () => {
  await assert.rejects(adapter(okJson('x')).transcribe({ audio: audio(), durationSeconds: 91 }), error => error.code === 'VOICE_AUDIO_TOO_LONG')
  await assert.rejects(adapter(okJson('x')).transcribe({ audio: audio(), durationSeconds: -1 }), error => error.code === 'VOICE_AUDIO_DURATION_INVALID')
})

test('oversized transcripts are rejected after the provider answers', async () => {
  await assert.rejects(adapter(okJson('a'.repeat(8001))).transcribe({ audio: audio() }), error => error.code === 'VOICE_TRANSCRIPT_TOO_LARGE')
})

test('OpenAI STT normalizes provider failure without exposing provider detail', async () => {
  const stt = adapter(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'secret detail' } }), text: async () => 'secret detail' }))
  await assert.rejects(stt.transcribe({ audio: audio() }), error => error.code === 'VOICE_STT_PROVIDER_FAILED' && !/secret|openai|Bearer/i.test(error.message))
})

test('transport failures never leak network or credential internals', async () => {
  const stt = adapter(async () => { throw new Error('connect ECONNREFUSED api.openai.com:443 key=sk-live') })
  await assert.rejects(stt.transcribe({ audio: audio() }), error => error.code === 'VOICE_STT_PROVIDER_FAILED' && !/openai|sk-|ECONNREFUSED/i.test(error.message))
})

test('deadline aborts as timeout and caller cancellation aborts as cancelled', async () => {
  const hang = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true })
  })
  await assert.rejects(adapter(hang, { timeoutMs: 15 }).transcribe({ audio: audio() }), error => error.code === 'VOICE_STT_TIMEOUT')
  const controller = new AbortController()
  const cancelled = adapter(hang, { timeoutMs: 5000 }).transcribe({ audio: audio(), signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, error => error.code === 'VOICE_CANCELLED')
  const already = new AbortController(); already.abort()
  let touched = false
  await assert.rejects(adapter(async () => { touched = true }).transcribe({ audio: audio(), signal: already.signal }), error => error.code === 'VOICE_CANCELLED')
  assert.equal(touched, false)
})

test('audio buffers are zeroed on success, failure and timeout alike', async () => {
  const success = audio()
  await withEphemeralAudio(success, buffer => adapter(okJson('ok')).transcribe({ audio: buffer }))
  assert.ok(success.every(byte => byte === 0), 'buffer must be zeroed after success')
  const failed = audio()
  await assert.rejects(withEphemeralAudio(failed, buffer => adapter(async () => ({ ok: false }))
    .transcribe({ audio: buffer })), error => error.code === 'VOICE_STT_PROVIDER_FAILED')
  assert.ok(failed.every(byte => byte === 0), 'buffer must be zeroed after provider failure')
  const timedOut = audio()
  const hang = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
  await assert.rejects(withEphemeralAudio(timedOut, buffer => adapter(hang, { timeoutMs: 15 }).transcribe({ audio: buffer })), error => error.code === 'VOICE_STT_TIMEOUT')
  assert.ok(timedOut.every(byte => byte === 0), 'buffer must be zeroed after timeout')
})

test('transcribe route enforces auth, tenant boundary, replay and ephemeral audio', () => {
  const source = fs.readFileSync(new URL('../src/routes/voice-agent.js', import.meta.url), 'utf8')
  assert.match(source, /r\.use\(auth\)/)
  assert.match(source, /await requireProject\(req, req\.query\.projectId\)/)
  assert.match(source, /express\.raw\(\{ type: audioTypes, limit: '8mb' \}\)/)
  assert.match(source, /VOICE_TRANSCRIBE_REPLAY/)
  assert.match(source, /Idempotency-Key/)
  assert.match(source, /withEphemeralAudio\(req\.body/)
  assert.match(source, /Cache-Control', 'no-store/)
  // Vendor identity and raw audio must never appear in the response body.
  assert.doesNotMatch(source, /provider: result\.provider, model: result\.model \}\)\s*$/m)
  assert.doesNotMatch(source, /json\(\{ transcript: result\.transcript[^}]*provider/)
})
