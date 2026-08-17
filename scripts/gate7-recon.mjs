// Read-only recon of the Phase 13 test fixtures. Never touches any other
// database: the identity assertion below is the first statement issued.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env') })
process.env.NODE_ENV = 'test'
process.env.YEEYOO_STRICT_TEST_DB = 'true'
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'FAL_KEY', 'STRIPE_SECRET_KEY', 'VOICE_STT_PROVIDER', 'VOICE_TTS_PROVIDER']) process.env[key] = ''

const { pool } = await import('../src/db.js')
const client = await pool.connect()
try {
  const identity = await client.query('SELECT current_database() AS name')
  if (identity.rows[0].name !== 'yeeyoo_phase13_test') throw new Error(`IDENTITY_REJECTED: ${identity.rows[0].name}`)
  console.log('database:', identity.rows[0].name)
  const users = await client.query('SELECT id, email FROM users ORDER BY email')
  console.log('users:', JSON.stringify(users.rows, null, 2))
  const projects = await client.query('SELECT id, user_id, name FROM projects ORDER BY user_id, id')
  console.log('projects:', JSON.stringify(projects.rows, null, 2))
  const counts = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM sosy_delegations) AS delegations,
    (SELECT COUNT(*)::int FROM marketing_artifacts) AS artifacts,
    (SELECT COUNT(*)::int FROM tony_conversations) AS conversations,
    (SELECT COUNT(*)::int FROM marketing_campaigns) AS campaigns`)
  console.log('counts:', JSON.stringify(counts.rows[0]))
} finally {
  client.release()
  await pool.end()
}
