import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations')
const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_[a-z0-9][a-z0-9_-]*\.sql$/
const LOCK_ID = 974_926_068

export async function discoverMigrations(directory = DEFAULT_DIR) {
  const names = (await fs.readdir(directory)).filter(name => FILE_PATTERN.test(name)).sort()
  return Promise.all(names.map(async name => {
    const sql = await fs.readFile(path.join(directory, name), 'utf8')
    return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') }
  }))
}

export async function runMigrations(client, { directory = DEFAULT_DIR, migrations } = {}) {
  const files = migrations || await discoverMigrations(directory)
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    const applied = await client.query('SELECT name, checksum FROM schema_migrations')
    const ledger = new Map(applied.rows.map(row => [row.name, row.checksum]))
    const executed = []
    for (const migration of files) {
      if (ledger.has(migration.name)) {
        if (ledger.get(migration.name) !== migration.checksum) throw new Error(`Applied migration changed: ${migration.name}`)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum])
        await client.query('COMMIT')
        executed.push(migration.name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration failed: ${migration.name}`, { cause: error })
      }
    }
    return { discovered: files.length, executed }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
  }
}
