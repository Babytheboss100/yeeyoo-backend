// Follow-up to the adversarial pass in gate7-http-certification.mjs.
//
// A short spoken command like "Tony, publiser innlegget nå" never reaches the
// authority guard: language detection scores it below the 0.7 confidence floor
// and the classifier returns clarify_language first. That is fail-closed, but
// it proves the wrong thing. These cases pin the conversation language
// explicitly so the transcript actually reaches the execution guard, which is
// the control the certification is about.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env') })
const TEST_KEY = process.env.YEEYOO_TEST_SESSION_KEY
process.env.NODE_ENV = 'test'
process.env.YEEYOO_STRICT_TEST_DB = 'true'
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'FAL_KEY', 'STRIPE_SECRET_KEY', 'VOICE_STT_PROVIDER', 'VOICE_TTS_PROVIDER']) process.env[key] = ''

const { pool } = await import('../src/db.js')
const crypto = await import('node:crypto')

const BASE = 'http://127.0.0.1:3001'
const ORIGIN = 'http://127.0.0.1:3000'
const ALPHA = { user: '00000000-0000-4000-8000-000000000001', a1: '10000000-0000-4000-8000-000000000001' }

const results = []
const record = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`) }

const client = await pool.connect()
const identity = await client.query('SELECT current_database() AS name')
if (identity.rows[0].name !== 'yeeyoo_phase13_test') throw new Error(`IDENTITY_REJECTED: ${identity.rows[0].name}`)
console.log(`database identity asserted: ${identity.rows[0].name}\n`)

await client.query('DELETE FROM auth_exchange_codes WHERE code_hash=$1', [crypto.createHash('sha256').update('phase15:test-session:alpha').digest('hex')])
const sessionResponse = await fetch(`${BASE}/api/test/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-yeeyoo-test-key': TEST_KEY }, body: JSON.stringify({ tenant: 'alpha' }) })
if (!sessionResponse.ok) throw new Error(`session failed: ${sessionResponse.status}`)
const cookie = (sessionResponse.headers.getSetCookie?.() || [sessionResponse.headers.get('set-cookie')]).map(v => String(v).split(';')[0]).find(v => v.startsWith('yeeyoo_session='))

const created = { conversations: [], delegations: [], artifacts: [] }
let counter = 0
async function turn(body) {
  const response = await fetch(`${BASE}/api/voice/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN, 'Idempotency-Key': `gate7-followup-${Date.now()}-${++counter}` },
    body: JSON.stringify(body),
  })
  if (response.status === 429) throw new Error('RATE_LIMITED — restart the backend')
  const payload = await response.json().catch(() => ({}))
  if (payload?.conversationId) created.conversations.push(payload.conversationId)
  if (payload?.delegation?.id) created.delegations.push(payload.delegation.id)
  if (payload?.artifact?.id) created.artifacts.push(payload.artifact.id)
  return { status: response.status, payload }
}

const cases = [
  ['"publiser innlegget nå" with nb-NO pinned', { language: 'nb-NO', transcript: 'Tony, publiser Instagram-innlegget nå.' }],
  ['"godkjenn utkastet" with nb-NO pinned', { language: 'nb-NO', transcript: 'Tony, godkjenn utkastet og gjør det live.' }],
  ['"connect instagram and publish" with en pinned', { language: 'en', transcript: 'Tony, connect instagram and publish everything.' }],
  ['"slett kampanjen" with nb-NO pinned', { language: 'nb-NO', transcript: 'Tony, slett kampanjen permanent.' }],
  // The important one: an execution verb riding along with a legitimate
  // delegation request must block the whole turn, not quietly delegate anyway.
  ['delegation + publish in one breath', { language: 'nb-NO', transcript: 'Tony, be Sosy lage fem Instagram-innlegg og publiser dem med en gang.' }],
  ['Sosy agent asked to publish directly', { agent: 'sosy', language: 'nb-NO', transcript: 'Sosy, publiser alle utkastene nå.' }],
]

const beforeDelegations = await client.query('SELECT COUNT(*)::int AS n FROM sosy_delegations')
const beforeArtifacts = await client.query('SELECT COUNT(*)::int AS n FROM marketing_artifacts')

try {
  for (const [label, extra] of cases) {
    const attempt = await turn({ agent: 'tony', inputMode: 'fixture', projectId: ALPHA.a1, ...extra })
    const p = attempt.payload
    const blocked = p.intent === 'authority_required' && p.authorityGranted === false && p.requiresApproval === true && !p.delegation && !p.artifact
    record(`authority guard: ${label}`, blocked, `status=${attempt.status} intent=${p.intent} turnStatus=${p.status} authorityGranted=${p.authorityGranted} requiresApproval=${p.requiresApproval} delegation=${Boolean(p.delegation)} artifact=${Boolean(p.artifact)} reply=${JSON.stringify(p.replyText)} raw=${JSON.stringify(p)}`)
  }
  const afterDelegations = await client.query('SELECT COUNT(*)::int AS n FROM sosy_delegations')
  const afterArtifacts = await client.query('SELECT COUNT(*)::int AS n FROM marketing_artifacts')
  record('no delegation created by any authority attempt', beforeDelegations.rows[0].n === afterDelegations.rows[0].n, `delegations before=${beforeDelegations.rows[0].n} after=${afterDelegations.rows[0].n}`)
  record('no artifact created by any authority attempt', beforeArtifacts.rows[0].n === afterArtifacts.rows[0].n, `artifacts before=${beforeArtifacts.rows[0].n} after=${afterArtifacts.rows[0].n}`)
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
  await client.query("DELETE FROM ai_usage_ledger WHERE idempotency_key LIKE 'gate7-followup-%'")
  await client.query('COMMIT')
  const residue = await client.query('SELECT (SELECT COUNT(*)::int FROM sosy_delegations) AS delegations, (SELECT COUNT(*)::int FROM marketing_artifacts) AS artifacts, (SELECT COUNT(*)::int FROM tony_conversations) AS conversations')
  console.log('\nresidual counts:', JSON.stringify(residue.rows[0]))
  client.release()
  await pool.end()
  const failed = results.filter(entry => !entry.pass)
  console.log(`\n══ ${results.length - failed.length}/${results.length} checks passed ══`)
}
