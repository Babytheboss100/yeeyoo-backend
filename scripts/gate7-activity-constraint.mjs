// Read-only: what event_type values does project_activity actually accept, and
// is the value the Sosy voice path writes among them?
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env') })
process.env.NODE_ENV = 'test'
process.env.YEEYOO_STRICT_TEST_DB = 'true'
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOICE_STT_PROVIDER', 'VOICE_TTS_PROVIDER']) process.env[key] = ''

const { pool } = await import('../src/db.js')
const client = await pool.connect()
try {
  const identity = await client.query('SELECT current_database() AS name')
  if (identity.rows[0].name !== 'yeeyoo_phase13_test') throw new Error('IDENTITY_REJECTED')
  const constraint = await client.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'project_activity'::regclass AND contype = 'c'`)
  for (const row of constraint.rows) console.log(`${row.conname}:\n${row.definition}\n`)
} finally {
  client.release()
  await pool.end()
}
