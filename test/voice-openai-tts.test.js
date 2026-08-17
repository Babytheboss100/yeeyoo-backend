import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DeterministicTextToSpeechAdapter, OpenAITextToSpeechAdapter, createTextToSpeechAdapter } from '../src/voice/adapters.js'
import { publicAudioDescriptor, releaseSynthesizedAudio, withEphemeralSynthesis } from '../src/voice/audioLifecycle.js'

// Offline only: fetchImpl is always a stub, never a real socket.
const bytes = (size = 4096) => Buffer.alloc(size, 7)
const okAudio = (size = 4096) => async () => ({ ok: true, arrayBuffer: async () => bytes(size).buffer.slice(0, size) })
const adapter = (fetchImpl, options = {}) => new OpenAITextToSpeechAdapter({ apiKey: 'test-only', fetchImpl, ...options })

test('real TTS mirrors the deterministic adapter interface', () => {
  const real = adapter(okAudio()), fixture = new DeterministicTextToSpeechAdapter()
  assert.equal(typeof real.synthesize, typeof fixture.synthesize)
  assert.equal(real.synthesize.length, fixture.synthesize.length)
  assert.equal(real.streaming, false)
})

test('real TTS posts neutral synthesis request and returns ephemeral bytes', async () => {
  let request
  const tts = adapter(async (url, options) => { request = { url, options }; return { ok: true, arrayBuffer: async () => bytes(9000).buffer } })
  const result = await tts.synthesize({ text: 'Hei, her er ukens plan.', language: 'nb-NO', voiceIdentity: 'tony-standard', audioFormat: 'mp3' })
  const body = JSON.parse(request.options.body)
  assert.equal(request.url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(request.options.headers.Authorization, 'Bearer test-only')
  assert.equal(body.model, 'gpt-4o-mini-tts')
  assert.equal(body.voice, 'alloy')
  assert.equal(body.response_format, 'mp3')
  assert.equal(result.audio.kind, 'bytes')
  assert.equal(result.audio.mimeType, 'audio/mpeg')
  assert.equal(result.audio.byteLength, 9000)
  assert.equal(result.audio.ephemeral, true)
  assert.equal(result.audio.persisted, false)
  assert.equal(result.language, 'nb-NO')
  assert.deepEqual(result.usage, { characters: 'Hei, her er ukens plan.'.length })
})

test('all canonical voice languages and both identities synthesize', async () => {
  for (const language of ['nb-NO', 'pt-BR', 'en', 'es']) {
    const result = await adapter(okAudio()).synthesize({ text: 'Bom dia', language, voiceIdentity: 'sosy-standard' })
    assert.equal(result.language, language)
    assert.equal(result.voiceIdentity, 'sosy-standard')
    assert.ok(result.audio.byteLength > 0)
  }
  let voice
  await adapter(async (url, options) => { voice = JSON.parse(options.body).voice; return { ok: true, arrayBuffer: async () => bytes().buffer } })
    .synthesize({ text: 'Oi', language: 'pt-BR', voiceIdentity: 'sosy-standard' })
  assert.equal(voice, 'shimmer')
  await assert.rejects(adapter(okAudio()).synthesize({ text: 'x', language: 'de-DE' }), error => error.code === 'VOICE_LANGUAGE_UNSUPPORTED')
  await assert.rejects(adapter(okAudio()).synthesize({ text: 'x', language: 'en', voiceIdentity: 'admin-voice' }), error => error.code === 'VOICE_TTS_IDENTITY_UNSUPPORTED')
  await assert.rejects(adapter(okAudio()).synthesize({ text: 'x', language: 'en', audioFormat: 'midi' }), error => error.code === 'VOICE_TTS_FORMAT_UNSUPPORTED')
})

test('real TTS factory fails closed unless explicitly configured', () => {
  assert.throws(() => createTextToSpeechAdapter({ env: {} }), error => error.code === 'VOICE_TTS_NOT_CONFIGURED')
  assert.throws(() => createTextToSpeechAdapter({ env: { OPENAI_API_KEY: 'test' } }), error => error.code === 'VOICE_TTS_NOT_CONFIGURED')
  const configured = createTextToSpeechAdapter({ env: { VOICE_TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'test' } })
  assert.equal(configured.provider, 'openai')
  assert.equal(configured.model, 'gpt-4o-mini-tts')
  assert.equal(createTextToSpeechAdapter({ env: { VOICE_TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'test', VOICE_TTS_MODEL: 'tts-1' } }).model, 'tts-1')
})

test('missing key and empty text fail closed without reaching the network', async () => {
  let called = false
  await assert.rejects(new OpenAITextToSpeechAdapter({ apiKey: '', fetchImpl: async () => { called = true } }).synthesize({ text: 'hi', language: 'en' }),
    error => error.code === 'VOICE_TTS_NOT_CONFIGURED')
  await assert.rejects(adapter(async () => { called = true }).synthesize({ text: '   ', language: 'en' }), error => error.code === 'VOICE_TTS_EMPTY')
  await assert.rejects(adapter(async () => { called = true }).synthesize({ text: 'a'.repeat(8001), language: 'en' }), error => error.code === 'VOICE_TTS_TOO_LARGE')
  assert.equal(called, false)
})

test('TTS provider failure, silence and transport errors stay vendor-neutral', async () => {
  await assert.rejects(adapter(async () => ({ ok: false, status: 429, text: async () => 'openai rate limit sk-live' })).synthesize({ text: 'hi', language: 'en' }),
    error => error.code === 'VOICE_TTS_PROVIDER_FAILED' && !/openai|sk-|rate limit/i.test(error.message))
  await assert.rejects(adapter(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })).synthesize({ text: 'hi', language: 'en' }),
    error => error.code === 'VOICE_TTS_NO_AUDIO')
  await assert.rejects(adapter(async () => { throw new Error('getaddrinfo api.openai.com') }).synthesize({ text: 'hi', language: 'en' }),
    error => error.code === 'VOICE_TTS_PROVIDER_FAILED' && !/openai/i.test(error.message))
})

test('TTS deadline aborts as timeout and caller cancellation aborts as cancelled', async () => {
  const hang = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
  await assert.rejects(adapter(hang, { timeoutMs: 15 }).synthesize({ text: 'hi', language: 'en' }), error => error.code === 'VOICE_TTS_TIMEOUT')
  const controller = new AbortController()
  const pending = adapter(hang, { timeoutMs: 5000 }).synthesize({ text: 'hi', language: 'en', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.code === 'VOICE_CANCELLED')
  const already = new AbortController(); already.abort()
  let touched = false
  await assert.rejects(adapter(async () => { touched = true }).synthesize({ text: 'hi', language: 'en', signal: already.signal }), error => error.code === 'VOICE_CANCELLED')
  assert.equal(touched, false)
})

test('synthesized audio is zeroed and never surfaces in a public descriptor', async () => {
  const result = await adapter(okAudio(512)).synthesize({ text: 'hi', language: 'en' })
  const captured = result.audio.bytes
  assert.ok(captured.some(byte => byte !== 0))
  const descriptor = publicAudioDescriptor(result)
  assert.equal('bytes' in descriptor, false)
  assert.equal(descriptor.persisted, false)
  releaseSynthesizedAudio(result)
  assert.ok(captured.every(byte => byte === 0), 'synthesized bytes must be zeroed on release')
  assert.equal(result.audio.bytes, null)

  const scoped = await adapter(okAudio(512)).synthesize({ text: 'hi', language: 'en' })
  const scopedBytes = scoped.audio.bytes
  await assert.rejects(withEphemeralSynthesis(scoped, () => { throw new Error('downstream failed') }), /downstream failed/)
  assert.ok(scopedBytes.every(byte => byte === 0), 'synthesized bytes must be zeroed even when the consumer throws')
})

test('speak route streams ephemeral audio and never persists or names the vendor', () => {
  const source = fs.readFileSync(new URL('../src/routes/voice-agent.js', import.meta.url), 'utf8')
  assert.match(source, /r\.post\('\/speak'/)
  assert.match(source, /await requireProject\(req, body\.projectId \|\| req\.query\.projectId\)/)
  assert.match(source, /VOICE_SPEAK_REPLAY/)
  assert.match(source, /enforceVoiceCostLimits\(\{ turnCostUsd: estimateVoiceCostUsd/)
  // Bytes are released only after the socket drains, and only ever sent inline.
  assert.match(source, /res\.once\('close', \(\) => releaseSynthesizedAudio\(speech\)\)/)
  assert.match(source, /'Cache-Control': 'no-store'/)
  assert.doesNotMatch(source, /audioUrl|writeFile|createWriteStream|INSERT INTO voice_audio/)
  // The turn route writes only the stages it ran itself; the plan that decides
  // them, and the media-recorder skip inside it, is locked by
  // test/voice-turn-contract.test.js.
  assert.match(source, /planVoiceTurnLedgerStages\(\{ inputMode: body\.inputMode/)
  assert.doesNotMatch(source, /stage: 'tts'[^}]*db: client/)
})
