// Scope check for the project_activity constraint defect: does it break every
// Sosy-agent voice turn, or only the authority-blocked one?
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env') })
const TEST_KEY = process.env.YEEYOO_TEST_SESSION_KEY
process.env.NODE_ENV = 'test'
process.env.YEEYOO_STRICT_TEST_DB = 'true'
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOICE_STT_PROVIDER', 'VOICE_TTS_PROVIDER']) process.env[key] = ''

const { pool } = await import('../src/db.js')
const crypto = await import('node:crypto')
const client = await pool.connect()
const identity = await client.query('SELECT current_database() AS name')
if (identity.rows[0].name !== 'yeeyoo_phase13_test') throw new Error('IDENTITY_REJECTED')
console.log(`database identity asserted: ${identity.rows[0].name}\n`)

await client.query('DELETE FROM auth_exchange_codes WHERE code_hash=$1', [crypto.createHash('sha256').update('phase15:test-session:alpha').digest('hex')])
const s = await fetch('http://127.0.0.1:3001/api/test/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-yeeyoo-test-key': TEST_KEY }, body: JSON.stringify({ tenant: 'alpha' }) })
const cookie = (s.headers.getSetCookie?.() || []).map(v => v.split(';')[0]).find(v => v.startsWith('yeeyoo_session='))

const cases = [
  ['Sosy delegation (benign, no execution verb)', { agent: 'sosy', language: 'nb-NO', transcript: 'Sosy, lag fem Instagram-innlegg for Yeeyoo Brasil neste uke på brasiliansk portugisisk.' }],
  ['Sosy informational', { agent: 'sosy', language: 'nb-NO', transcript: 'Sosy, hvordan går det med innholdet vårt?' }],
  ['Tony control (same request, tony agent)', { agent: 'tony', language: 'nb-NO', transcript: 'Tony, be Sosy lage fem Instagram-innlegg for Yeeyoo Brasil neste uke på brasiliansk portugisisk.' }],
]
const created = { conversations: [], delegations: [], artifacts: [] }
let counter = 0
try {
  for (const [label, extra] of cases) {
    const response = await fetch('http://127.0.0.1:3001/api/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://127.0.0.1:3000', 'Idempotency-Key': `gate7-scope-${Date.now()}-${++counter}` },
      body: JSON.stringify({ inputMode: 'fixture', projectId: '10000000-0000-4000-8000-000000000001', ...extra }),
    })
    const payload = await response.json().catch(() => ({}))
    if (payload?.conversationId) created.conversations.push(payload.conversationId)
    if (payload?.delegation?.id) created.delegations.push(payload.delegation.id)
    if (payload?.artifact?.id) created.artifacts.push(payload.artifact.id)
    console.log(`${label}\n  status=${response.status} intent=${payload.intent ?? '-'} body=${JSON.stringify(payload).slice(0, 260)}\n`)
  }
  const delegations = await client.query('SELECT COUNT(*)::int AS n FROM sosy_delegations')
  const activity = await client.query("SELECT COUNT(*)::int AS n FROM project_activity WHERE event_type='sosy_voice_turn'")
  console.log(`sosy_delegations rows now=${delegations.rows[0].n}; project_activity sosy_voice_turn rows=${activity.rows[0].n}`)
} finally {
  await client.query('BEGIN')
  const check = await client.query('SELECT current_database() AS name')
  if (check.rows[0].name !== 'yeeyoo_phase13_test') { await client.query('ROLLBACK'); throw new Error('IDENTITY_REJECTED at cleanup') }
  const conversations = [...new Set(created.conversations.filter(Boolean))]
  if (conversations.length) {
    await client.query('DELETE FROM tony_messages WHERE conversation_id = ANY($1::text[])', [conversations])
    await client.query('DELETE FROM tony_conversations WHERE id = ANY($1::text[])', [conversations])
  }
  if (created.delegations.length) await client.query('DELETE FROM sosy_delegations WHERE id = ANY($1::text[])', [created.delegations])
  if (created.artifacts.length) await client.query('DELETE FROM marketing_artifacts WHERE id = ANY($1::text[])', [created.artifacts])
  await client.query("DELETE FROM ai_usage_ledger WHERE idempotency_key LIKE 'gate7-scope-%'")
  await client.query('COMMIT')
  const residue = await client.query('SELECT (SELECT COUNT(*)::int FROM sosy_delegations) AS delegations, (SELECT COUNT(*)::int FROM marketing_artifacts) AS artifacts, (SELECT COUNT(*)::int FROM tony_conversations) AS conversations')
  console.log('residual counts:', JSON.stringify(residue.rows[0]))
  client.release()
  await pool.end()
}
