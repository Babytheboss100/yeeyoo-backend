import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import dotenv from 'dotenv'
import { VOICE_SPEAK_ENDPOINT, VOICE_TTS_UNAVAILABLE_REASONS, describeVoiceTts, planVoiceTurnLedgerStages } from '../src/voice/turnContract.js'
import { createTextToSpeechAdapter } from '../src/voice/adapters.js'

// Loaded so the "this deployment" case below reads the real configuration
// rather than an empty environment that would pass for the wrong reason.
dotenv.config({ override: true })

const CONFIGURED = { VOICE_TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-test-key', AI_MODEL_PRICING_JSON: '' }
const routeSource = fs.readFileSync(new URL('../src/routes/voice-agent.js', import.meta.url), 'utf8')

test('a configured provider advertises the streamed speak endpoint and never names a vendor', () => {
  const tts = describeVoiceTts({ agent: 'tony', language: 'nb-NO', replyText: 'Jeg kan forberede dette.', env: CONFIGURED })
  assert.deepEqual(tts, {
    available: true, reason: null, mode: 'stream', endpoint: '/api/voice/speak',
    format: 'mp3', language: 'nb-NO', voiceIdentity: 'tony-standard',
  })
  assert.equal(VOICE_SPEAK_ENDPOINT, '/api/voice/speak')
  // The descriptor is user-facing: no provider, model or credential may ride on it.
  assert.doesNotMatch(JSON.stringify(tts).toLowerCase(), /openai|sk-|gpt-/)
})

test('an unconfigured deployment reports not_configured instead of promising audio', () => {
  // No provider selected at all: the factory fails closed.
  const unset = describeVoiceTts({ agent: 'tony', language: 'nb-NO', replyText: 'Hei', env: { AI_MODEL_PRICING_JSON: '' } })
  assert.equal(unset.available, false)
  assert.equal(unset.reason, 'not_configured')
  // Provider selected but no credential: equally unusable, so equally honest.
  const keyless = describeVoiceTts({ agent: 'tony', language: 'nb-NO', replyText: 'Hei', env: { VOICE_TTS_PROVIDER: 'openai', AI_MODEL_PRICING_JSON: '' } })
  assert.equal(keyless.available, false)
  assert.equal(keyless.reason, 'not_configured')
  // An unpriced model is a configuration gap, not a spend decision.
  const unpriced = describeVoiceTts({ agent: 'tony', language: 'nb-NO', replyText: 'Hei', env: { ...CONFIGURED, VOICE_TTS_MODEL: 'some-unlisted-voice-model' } })
  assert.equal(unpriced.available, false)
  assert.equal(unpriced.reason, 'not_configured')
  // Even when unavailable the descriptor stays complete, so the client can
  // explain the fallback rather than render an empty state.
  for (const descriptor of [unset, keyless, unpriced]) {
    assert.equal(descriptor.mode, 'stream')
    assert.equal(descriptor.endpoint, '/api/voice/speak')
    assert.equal(descriptor.format, 'mp3')
    assert.equal(descriptor.language, 'nb-NO')
    assert.equal(descriptor.voiceIdentity, 'tony-standard')
  }
})

test('this deployment reports not_configured under its own environment', () => {
  // The live guarantee, not a stub: with the placeholder key this repository
  // actually carries, /voice/turn must not claim generated speech is available.
  const tts = describeVoiceTts({ agent: 'tony', language: 'nb-NO', replyText: 'Hei' })
  if (process.env.VOICE_TTS_PROVIDER) {
    assert.ok(VOICE_TTS_UNAVAILABLE_REASONS.includes(tts.reason) || tts.available === true)
  } else {
    assert.equal(tts.available, false)
    assert.equal(tts.reason, 'not_configured')
    assert.throws(() => createTextToSpeechAdapter(), error => error.code === 'VOICE_TTS_NOT_CONFIGURED')
  }
})

test('empty text, unsupported language and the cost ceiling each get their own reason', () => {
  const empty = describeVoiceTts({ agent: 'tony', language: 'nb-NO', replyText: '   ', env: CONFIGURED })
  assert.equal(empty.reason, 'text_empty')
  const foreign = describeVoiceTts({ agent: 'tony', language: 'fr-FR', replyText: 'Bonjour', env: CONFIGURED })
  assert.equal(foreign.reason, 'unsupported_language')
  assert.equal(foreign.language, 'AUTO')
  // Over the per-turn spoken-text limit: refused before a single character is paid for.
  const oversized = describeVoiceTts({ agent: 'tony', language: 'en', replyText: 'a'.repeat(9000), env: CONFIGURED })
  assert.equal(oversized.reason, 'cost_ceiling')
  // Over the per-turn cost ceiling on price alone.
  const expensive = describeVoiceTts({
    agent: 'tony', language: 'en', replyText: 'a'.repeat(200),
    env: { ...CONFIGURED, AI_MODEL_PRICING_JSON: JSON.stringify({ version: 'ceiling-test', models: { 'openai/gpt-4o-mini-tts': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, perMillionCharacters: 10_000 } } }) },
  })
  assert.equal(expensive.reason, 'cost_ceiling')
  for (const descriptor of [empty, foreign, oversized, expensive]) {
    assert.equal(descriptor.available, false)
    assert.ok(VOICE_TTS_UNAVAILABLE_REASONS.includes(descriptor.reason), descriptor.reason)
  }
})

test('the voice identity follows the agent and never the caller', () => {
  assert.equal(describeVoiceTts({ agent: 'sosy', language: 'pt-BR', replyText: 'Olá', env: CONFIGURED }).voiceIdentity, 'sosy-standard')
  assert.equal(describeVoiceTts({ agent: 'administrator', language: 'en', replyText: 'Hi', env: CONFIGURED }).voiceIdentity, 'tony-standard')
})

test('a media-recorder turn never writes a second speech-to-text row', () => {
  // Regression lock: /voice/transcribe already billed voice.stt against the
  // real provider for this turn. A duplicate row here would attribute the same
  // transcription to a deterministic fixture, and the client now derives a
  // distinct key per stage so the unique constraint no longer hides it.
  const recorded = planVoiceTurnLedgerStages({ inputMode: 'media-recorder', agent: 'tony', durationSeconds: 6 })
  assert.deepEqual(recorded.map(entry => entry.stage), ['agent'])
  assert.equal(recorded[0].usage.model, 'tony-voice-orchestrator-v1')

  const browser = planVoiceTurnLedgerStages({ inputMode: 'browser-speech', agent: 'sosy', durationSeconds: 4 })
  assert.deepEqual(browser.map(entry => entry.stage), ['stt', 'agent'])
  assert.equal(browser[0].usage.provider, 'browser-speech')
  assert.equal(browser[0].usage.model, 'web-speech-api')
  assert.equal(browser[0].usage.audioSeconds, 4)
  assert.equal(browser[0].billable, false)
  assert.equal(browser[1].usage.model, 'sosy-voice-orchestrator-v1')

  const fixture = planVoiceTurnLedgerStages({ inputMode: 'fixture', agent: 'tony' })
  assert.deepEqual(fixture.map(entry => entry.stage), ['stt', 'agent'])
  assert.equal(fixture[0].usage.provider, 'deterministic-local')
  assert.equal(fixture[0].billable, false)

  // The turn performs orchestration and nothing else: it never claims a
  // synthesis stage, because /voice/speak owns voice.tts.
  for (const mode of ['fixture', 'browser-speech', 'media-recorder']) {
    const plan = planVoiceTurnLedgerStages({ inputMode: mode, agent: 'tony' })
    assert.ok(plan.some(entry => entry.stage === 'agent'), mode)
    assert.ok(!plan.some(entry => entry.stage === 'tts'), mode)
  }
})

test('the turn route returns the canonical no-audio contract and no vendor name', () => {
  assert.match(routeSource, /res\.status\(200\)\.json\(\{ \.\.\.result, \.\.\.persisted, audio: null, streaming: false, tts \}\)/)
  assert.match(routeSource, /describeVoiceTts\(\{ agent: result\.agent/)
  assert.match(routeSource, /planVoiceTurnLedgerStages\(\{ inputMode: body\.inputMode/)
  // voiceProvider named the vendor to the user; it must stay out of the body.
  assert.doesNotMatch(routeSource, /voiceProvider/)
  // No hosted audio URL exists by design, so no route may mint one.
  assert.doesNotMatch(routeSource, /audioUrl/)
  assert.match(routeSource, /r\.post\('\/speak'/)
  assert.match(routeSource, /'Cache-Control': 'no-store'/)
})
