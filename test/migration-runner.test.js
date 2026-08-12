import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverMigrations, runMigrations } from '../src/services/migrationRunner.js'

function fakeClient(initial = []) {
  const ledger = new Map(initial.map(row => [row.name, row.checksum]))
  const calls = []
  return { calls, ledger, async query(sql, params = []) {
    calls.push({ sql, params })
    if (sql.startsWith('SELECT name')) return { rows: [...ledger].map(([name, checksum]) => ({ name, checksum })) }
    if (sql.startsWith('INSERT INTO schema_migrations')) ledger.set(params[0], params[1])
    if (sql === 'FAIL') throw new Error('synthetic failure')
    return { rows: [] }
  } }
}
const migrations = [{ name: '2026-01-01_one.sql', checksum: 'a', sql: 'ONE' }, { name: '2026-01-02_two.sql', checksum: 'b', sql: 'TWO' }]
test('migration discovery is strictly ordered and includes the core baseline', async () => { const found = await discoverMigrations(); assert.deepEqual(found.map(x => x.name), [...found.map(x => x.name)].sort()); assert.ok(found.some(x => x.name === '2026-05-23_core_baseline.sql')) })
test('runner applies ordered migrations and rerun executes none', async () => { const db = fakeClient(); assert.deepEqual((await runMigrations(db, { migrations })).executed, migrations.map(x => x.name)); assert.deepEqual((await runMigrations(db, { migrations })).executed, []) })
test('runner rejects modification of an applied migration', async () => { const db = fakeClient([{ name: migrations[0].name, checksum: 'tampered' }]); await assert.rejects(runMigrations(db, { migrations }), /Applied migration changed/); assert.ok(db.calls.some(x => x.sql.includes('pg_advisory_unlock'))) })
test('runner rolls back a failed migration and does not record it', async () => { const db = fakeClient(); await assert.rejects(runMigrations(db, { migrations: [{ ...migrations[0], sql: 'FAIL' }] }), /Migration failed/); assert.ok(db.calls.some(x => x.sql === 'ROLLBACK')); assert.equal(db.ledger.size, 0) })
