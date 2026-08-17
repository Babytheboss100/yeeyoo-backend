// Confirms the two pages the owner is told to open actually render the shared
// voice control while authenticated. GET only — no voice turn is spent.
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
try {
  const identity = await client.query('SELECT current_database() AS name')
  if (identity.rows[0].name !== 'yeeyoo_phase13_test') throw new Error('IDENTITY_REJECTED')

  await client.query('DELETE FROM auth_exchange_codes WHERE code_hash=$1', [crypto.createHash('sha256').update('phase15:test-session:alpha').digest('hex')])
  const s = await fetch('http://127.0.0.1:3001/api/test/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-yeeyoo-test-key': TEST_KEY }, body: JSON.stringify({ tenant: 'alpha' }) })
  const cookie = (s.headers.getSetCookie?.() || []).map(v => v.split(';')[0]).find(v => v.startsWith('yeeyoo_session='))
  console.log(`session minted: ${Boolean(cookie)}\n`)

  for (const [label, url] of [['Tony', 'http://127.0.0.1:3000/dashboard/chat'], ['Sosy', 'http://127.0.0.1:3000/dashboard/sosy']]) {
    const response = await fetch(url, { headers: { cookie }, redirect: 'manual' })
    const html = response.status === 200 ? await response.text() : ''
    const hasMic = /Start microphone input/.test(html)
    console.log(`${label}  ${url}\n  status=${response.status}${response.status >= 300 && response.status < 400 ? ` -> ${response.headers.get('location')}` : ''} htmlBytes=${html.length} mentionsVoiceControl=${hasMic}`)
  }
} finally {
  client.release()
  await pool.end()
}
