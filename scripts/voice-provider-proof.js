#!/usr/bin/env node
// Gate 4 (real STT) + Gate 6 (real TTS) round-trip proof.
//
// Explicit invocation only. This lives in scripts/, not test/, so `npm test`
// (node --test test/*.test.js) can never pick it up, and it refuses to start
// without an explicit flag.
//
//   node scripts/voice-provider-proof.js --confirm-live-provider
//       Real provider. Synthesizes a Norwegian and a Brazilian-Portuguese
//       utterance, feeds each straight back into transcription, and prints the
//       transcripts, audio byte lengths, content types and ledger entries.
//       Requires a live OPENAI_API_KEY in this repository's own .env. Spends
//       roughly one cent of provider credit.
//
//   node scripts/voice-provider-proof.js --loopback
//       No network, no credential, no spend. Runs the identical adapter code
//       over real HTTP sockets against a local server that answers with a real
//       RIFF/WAVE stream. Proves the wire contract — multipart encoding, the
//       language codes actually sent, byte handling, ledger separation — but
//       NOT the provider's transcription quality.
//
// Safety in both modes: no database is contacted (the ledger writes into an
// in-memory capture), no audio is written to disk, every buffer is zeroed in a
// finally, and the API key is never printed.
import http from 'node:http'
import dotenv from 'dotenv'
import { createSpeechToTextAdapter, createTextToSpeechAdapter } from '../src/voice/adapters.js'
import { withEphemeralAudio, releaseSynthesizedAudio } from '../src/voice/audioLifecycle.js'
import { recordVoiceUsage } from '../src/voice/cost.js'

dotenv.config()

const loopback = process.argv.includes('--loopback')
const live = process.argv.includes('--confirm-live-provider') || process.env.VOICE_PROVIDER_PROOF === '1'
if (!loopback && !live) {
  console.error('Refusing to run: pass --confirm-live-provider (spends real provider credit) or --loopback (offline wire proof).')
  process.exit(2)
}
if (live && !loopback) {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Refusing to run: no provider key configured in this repository\'s .env.')
    process.exit(2)
  }
  // A placeholder key would spend a full round of requests to learn nothing.
  if (process.env.OPENAI_API_KEY.trim().length < 20) {
    console.error('Refusing to run: OPENAI_API_KEY in this repository\'s .env is a placeholder, not a live credential.')
    console.error('Set a real key in that file, or run with --loopback for the offline wire proof.')
    process.exit(2)
  }
}

const UTTERANCES = [
  { language: 'nb-NO', voiceIdentity: 'tony-standard', text: 'Hei Tony, kan du lage fem innlegg til neste uke?' },
  { language: 'pt-BR', voiceIdentity: 'sosy-standard', text: 'Oi Sosy, você pode criar cinco posts para a próxima semana?' },
]

// ─── Loopback provider ───────────────────────────────────────────────────────
// Answers the two endpoints the adapters call, with a genuine 24 kHz mono
// 16-bit RIFF/WAVE stream, so the whole byte path is exercised for real.
function riffWave(seconds = 1.5, rate = 24000) {
  const samples = Math.floor(seconds * rate), data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const wireChecks = []
async function startLoopback() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.url.endsWith('/audio/speech')) {
        const payload = JSON.parse(body.toString('utf8'))
        wireChecks.push({ endpoint: 'speech', authorized: (req.headers.authorization || '').startsWith('Bearer '), model: payload.model, voice: payload.voice, format: payload.response_format })
        const wav = riffWave()
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length })
        return res.end(wav)
      }
      // Crude but sufficient: assert the multipart parts the provider requires
      // are actually on the wire, and echo back the matching utterance.
      const raw = body.toString('latin1')
      const field = name => raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] ?? null
      const language = field('language')
      wireChecks.push({ endpoint: 'transcriptions', authorized: (req.headers.authorization || '').startsWith('Bearer '), model: field('model'), language, responseFormat: field('response_format'), filename: raw.match(/filename="([^"]+)"/)?.[1] ?? null, carriesRiff: raw.includes('RIFF'), bytes: body.length })
      const spokenLanguage = { no: 'nb-NO', pt: 'pt-BR', en: 'en', es: 'es' }[language]
      const match = UTTERANCES.find(item => item.language === spokenLanguage)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: match ? match.text : '' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

// ─── Ledger capture (no database is contacted) ───────────────────────────────
const ledger = []
const captureDb = { query: async (sql, values) => { ledger.push({ operation: values[8], provider: values[9], model: values[10], idempotencyKey: values[11], mediaUnits: values[17], mediaUnitType: values[18], costUsd: values[19], costSource: values[22], billable: values[23] }); return { rows: [{ id: values[0] }] } } }
const turn = { id: 'voice-proof-turn', sessionId: 'voice-proof-session', userId: 'voice-proof-user', projectId: 'voice-proof-project', agent: 'tony' }

const isRiffWave = bytes => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE'

async function proveRoundTrip({ language, voiceIdentity, text }, { env, baseUrl }) {
  const tts = createTextToSpeechAdapter({ env, ...(baseUrl ? { baseUrl } : {}) })
  const stt = createSpeechToTextAdapter({ env, ...(baseUrl ? { baseUrl } : {}) })
  const spoken = await tts.synthesize({ text, language, voiceIdentity, audioFormat: 'wav' })
  try {
    const byteLength = spoken.audio.byteLength
    if (byteLength < 4096) throw new Error(`${language}: synthesized audio is trivially small (${byteLength} bytes)`)
    if (!isRiffWave(spoken.audio.bytes)) throw new Error(`${language}: synthesized audio is not a decodable RIFF/WAVE stream`)
    await recordVoiceUsage({ turn, stage: 'tts', idempotencyKey: `voice-proof:${language}:tts`, usage: { characters: spoken.usage.characters, provider: spoken.provider, model: spoken.model } }, { db: captureDb, env })

    // Round trip: the synthesized bytes become the transcription input, copied
    // once so each buffer can be released independently.
    const durationSeconds = Number(((byteLength - 44) / (24000 * 2)).toFixed(2))
    const heard = await withEphemeralAudio(Buffer.from(spoken.audio.bytes), recording =>
      stt.transcribe({ audio: recording, mimeType: 'audio/wav', languageHint: language, durationSeconds }))
    await recordVoiceUsage({ turn, stage: 'stt', idempotencyKey: `voice-proof:${language}:stt`, usage: { audioSeconds: heard.usage.audioSeconds, provider: heard.provider, model: heard.model } }, { db: captureDb, env })

    return { language, spoken: text, byteLength, contentType: spoken.audio.contentType, format: spoken.audio.format, ttsModel: spoken.model, sttModel: heard.model, transcript: heard.transcript, detectedLanguage: heard.detectedLanguage, durationSeconds }
  } finally {
    releaseSynthesizedAudio(spoken)
  }
}

// The adapters deliberately never carry provider detail into an error, so on
// failure we ask one credential question and report only the HTTP status —
// never the key, never the provider's message.
async function diagnose() {
  try {
    const probe = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } })
    await probe.body?.cancel?.().catch(() => {})
    if (probe.status === 401 || probe.status === 403) return `the configured credential was rejected by the provider (HTTP ${probe.status})`
    if (probe.status === 429) return 'the provider is rate limiting or the account has no remaining credit (HTTP 429)'
    return `credential accepted (HTTP ${probe.status}); the failure is model or request specific`
  } catch { return 'the provider could not be reached from this machine' }
}

const loopbackServer = loopback ? await startLoopback() : null
// The proof is the explicit opt-in, so the real providers are selected here
// rather than requiring the runtime env to already be switched over.
const env = {
  ...process.env,
  OPENAI_API_KEY: loopback ? 'loopback-not-a-real-credential' : process.env.OPENAI_API_KEY,
  VOICE_STT_PROVIDER: 'openai',
  VOICE_TTS_PROVIDER: 'openai',
}

const results = []
let failure = null
try {
  for (const utterance of UTTERANCES) results.push(await proveRoundTrip(utterance, { env, baseUrl: loopbackServer?.baseUrl }))
} catch (error) {
  failure = error
} finally {
  loopbackServer?.server.close()
}
if (failure) {
  console.error(`\nPROOF FAILED: ${failure.code || 'ERROR'} — ${failure.message}`)
  if (!loopback) console.error(`diagnosis: ${await diagnose()}`)
  process.exit(1)
}

const mode = loopback ? 'LOOPBACK WIRE PROOF (no provider intelligence)' : 'LIVE PROVIDER'
console.log(`\n=== GATE 6: speech synthesis — ${mode} ===`)
for (const row of results) console.log(`${row.language}  bytes=${row.byteLength}  contentType=${row.contentType}  format=${row.format}  riffWave=yes  model=${row.ttsModel}`)
console.log(`\n=== GATE 4: speech-to-text round trip — ${mode} ===`)
for (const row of results) {
  console.log(`${row.language}  model=${row.sttModel}  detected=${row.detectedLanguage}  seconds=${row.durationSeconds}`)
  console.log(`  spoken:     ${row.spoken}`)
  console.log(`  transcript: ${row.transcript}`)
}
if (loopback) {
  console.log('\n=== WIRE CONTRACT OBSERVED BY THE LOOPBACK PROVIDER ===')
  for (const check of wireChecks) console.log(JSON.stringify(check))
}
console.log('\n=== COST LEDGER (captured in memory, never written) ===')
for (const entry of ledger) console.log(JSON.stringify(entry))
console.log(`\noperations recorded: ${[...new Set(ledger.map(entry => entry.operation))].sort().join(', ')}`)
console.log('audio persisted: none (in-memory only, buffers zeroed)')
