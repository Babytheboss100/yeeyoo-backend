import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import dotenv from 'dotenv'

// Every other database-backed test loads the disposable test connection string
// itself; without this the file failed closed on a missing variable rather than
// running, so it was passing on nobody's machine but an exported shell.
dotenv.config({ override: true })

const EXPECTED_DATABASE = 'yeeyoo_phase13_test'
const USER = '00000000-0000-4000-8000-000000000001'
const PROJECT = '10000000-0000-4000-8000-000000000001'

async function verifiedClient() {
  if (!process.env.YEEYOO_TEST_DATABASE_URL) throw new Error('YEEYOO_TEST_DATABASE_URL is required')
  const client = new pg.Client({ connectionString: process.env.YEEYOO_TEST_DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  const { rows } = await client.query('SELECT current_database() AS name')
  if (rows[0]?.name !== EXPECTED_DATABASE) { await client.end(); throw new Error('Disposable test database identity rejected') }
  return client
}

test('canonical AI ledger is persisted, tenant-bound and replay-idempotent', async () => {
  const client = await verifiedClient()
  const key = `phase26-${process.pid}-${Date.now()}`
  await client.query('BEGIN')
  try {
    const values = [USER, PROJECT, 'copy', 'local', 'deterministic-fixture-v1', key, 'succeeded', 'non-billable-v1']
    const first = await client.query(`INSERT INTO ai_usage_ledger
      (user_id,project_id,operation,provider,model,idempotency_key,status,billable,cost_source,pricing_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,FALSE,'non_billable',$8) RETURNING id`, values)
    assert.equal(first.rowCount, 1)
    const replay = await client.query(`INSERT INTO ai_usage_ledger
      (user_id,project_id,operation,provider,model,idempotency_key,status,billable,cost_source,pricing_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,FALSE,'non_billable',$8)
      ON CONFLICT ON CONSTRAINT ai_usage_ledger_attempt_unique DO NOTHING`, values)
    assert.equal(replay.rowCount, 0)
    await assert.rejects(() => client.query(`INSERT INTO ai_usage_ledger
      (user_id,project_id,operation,provider,model,idempotency_key,status,billable,cost_source,pricing_version)
      VALUES('00000000-0000-4000-8000-000000000002',$1,'copy','local','deterministic-fixture-v1',$2,'succeeded',FALSE,'non_billable','non-billable-v1')`, [PROJECT, `${key}-foreign`]), error => error.code === '23503')
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
})
