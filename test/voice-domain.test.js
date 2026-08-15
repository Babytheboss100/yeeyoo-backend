import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceTurn, detectVoiceLanguage, enforceVoiceCostLimits, enforceVoiceLimits, normalizeVoiceLanguage } from '../src/voice/domain.js'
import { createDeterministicVoiceAdapters } from '../src/voice/adapters.js'
import { withEphemeralAudio } from '../src/voice/audioLifecycle.js'
import { recordVoiceUsage } from '../src/voice/cost.js'

test('automatic language detection covers initial languages and asks when ambiguous', () => {
  assert.equal(detectVoiceLanguage('Jeg vil lage neste uke på norsk').language, 'nb-NO')
  assert.equal(detectVoiceLanguage('Você pode criar em português para o Brasil').language, 'pt-BR')
  assert.equal(detectVoiceLanguage('Please create the plan for next week').language, 'en')
  assert.equal(detectVoiceLanguage('Crear para la próxima semana en español').language, 'es')
  assert.equal(detectVoiceLanguage('Instagram').requiresClarification, true)
  assert.equal(normalizeVoiceLanguage('pt_br'), 'pt-BR')
})

test('voice turn separates Norwegian conversation from Portuguese output', () => {
  const turn = createVoiceTurn({ userId: 'alpha', projectId: 'a1', agent: 'tony', transcript: 'Jeg vil lage neste uke på norsk', language: 'AUTO', outputLanguage: 'pt-BR' }, { id: 'turn-1', now: '2026-08-25T00:00:00Z' })
  assert.equal(turn.conversationLanguage, 'nb-NO')
  assert.equal(turn.outputLanguage, 'pt-BR')
  assert.equal(turn.source, 'voice')
})

test('privacy and safety limits reject oversized inputs', () => {
  assert.throws(() => enforceVoiceLimits({ durationSeconds: 91 }), { code: 'VOICE_AUDIO_TOO_LONG' })
  assert.throws(() => createVoiceTurn({ userId: 'u', projectId: 'p', agent: 'tony', transcript: 'x'.repeat(8001), language: 'en' }), { code: 'VOICE_TRANSCRIPT_TOO_LARGE' })
  assert.throws(() => enforceVoiceCostLimits({ turnCostUsd: .26 }), { code: 'VOICE_TURN_COST_CEILING_EXCEEDED' })
  assert.throws(() => enforceVoiceCostLimits({ turnCostUsd: .2, sessionCostUsd: 1.9 }), { code: 'VOICE_SESSION_COST_CEILING_EXCEEDED' })
})

test('deterministic STT and TTS truthfully identify local fixtures', async () => {
  const { stt, tts } = createDeterministicVoiceAdapters({ fixtures: { norwegian: { transcript: 'Jeg vil lage neste uke på norsk', language: 'nb-NO', confidence: .99 } } })
  const transcript = await stt.transcribe({ fixtureId: 'norwegian', durationSeconds: 4 })
  assert.deepEqual([transcript.detectedLanguage, transcript.provider, transcript.streaming], ['nb-NO', 'deterministic-local', false])
  const speech = await tts.synthesize({ text: 'Klart.', language: 'nb-NO', voiceIdentity: 'tony-standard' })
  assert.equal(speech.audio.ephemeral, true)
  assert.equal(speech.usage.characters, 6)
})

test('ephemeral audio buffer is deterministically cleared after processing', async () => {
  const audio = Buffer.from('private microphone data')
  await withEphemeralAudio(audio, async input => assert.equal(input.length, 23))
  assert.ok(audio.every(byte => byte === 0))
})

test('voice cost stages use canonical non-billable ledger and idempotency keys', async () => {
  const calls = []
  const db = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ operation: values[8], cost_source: values[22], billable: values[23], media_units: values[17] }] } } }
  const turn = { id: 'turn-1', sessionId: 'session-1', userId: 'alpha', projectId: 'a1', agent: 'tony' }
  const { row } = await recordVoiceUsage({ turn, stage: 'stt', usage: { audioSeconds: 4 } }, { db })
  assert.deepEqual(row, { operation: 'voice.stt', cost_source: 'non_billable', billable: false, media_units: 4 })
  assert.equal(calls[0].values[11], 'turn-1:stt')
})

test('cancelled adapter work fails without fabricating output', async () => {
  const controller = new AbortController(); controller.abort()
  const { stt, tts } = createDeterministicVoiceAdapters({ fixtures: { one: { transcript: 'hello' } } })
  await assert.rejects(stt.transcribe({ fixtureId: 'one', signal: controller.signal }), { code: 'VOICE_CANCELLED' })
  await assert.rejects(tts.synthesize({ text: 'hello', language: 'en', signal: controller.signal }), { code: 'VOICE_CANCELLED' })
})
