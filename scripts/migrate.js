import pg from 'pg'
import { runMigrations } from '../src/services/migrationRunner.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_MIGRATIONS !== 'I_UNDERSTAND') {
  throw new Error('Production migrations require explicit ALLOW_PRODUCTION_MIGRATIONS acknowledgement')
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1 })
try {
  const client = await pool.connect()
  try { console.log(JSON.stringify(await runMigrations(client))) } finally { client.release() }
} finally { await pool.end() }
