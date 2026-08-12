import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config({ override: true })

const EXPECTED_DATABASE = 'yeeyoo_phase13_test'

async function isolatedClient(t) {
  if (!process.env.YEEYOO_TEST_DATABASE_URL) return t.skip('YEEYOO_TEST_DATABASE_URL is not configured')
  const client = new pg.Client({ connectionString: process.env.YEEYOO_TEST_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
  await client.connect()
  t.after(() => client.end())
  const { rows } = await client.query('SELECT current_database() AS name')
  assert.equal(rows[0]?.name, EXPECTED_DATABASE, 'refusing to test any other database')
  return client
}

test('persisted Tony and Autopilot schema enforces canonical ownership and state', async t => {
  const client = await isolatedClient(t); if (!client) return
  const { rows } = await client.query(`SELECT table_name,column_name,is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND table_name IN
    ('tony_execution_plans','autopilot_policies','autopilot_action_audit','autopilot_action_approvals')`)
  const fields = new Set(rows.map(row => `${row.table_name}.${row.column_name}:${row.is_nullable}`))
  for (const field of [
    'tony_execution_plans.user_id:NO','tony_execution_plans.project_id:NO','tony_execution_plans.graph:NO',
    'autopilot_policies.project_id:NO','autopilot_policies.campaign_id:NO','autopilot_policies.level:NO',
    'autopilot_action_approvals.artifact_version:NO','autopilot_action_approvals.policy_version:NO',
    'autopilot_action_approvals.provider_connection_version:NO','autopilot_action_approvals.fingerprint:NO',
    'autopilot_action_approvals.nonce:NO','autopilot_action_approvals.expires_at:NO',
  ]) assert.ok(fields.has(field), `missing persistence invariant ${field}`)
})

test('approval replay and expiry constraints exist in PostgreSQL, not only application code', async t => {
  const client = await isolatedClient(t); if (!client) return
  const { rows } = await client.query(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.autopilot_action_approvals'::regclass`)
  const definitions = rows.map(row => row.definition).join('\n')
  assert.match(definitions,/UNIQUE \(project_id, nonce\)/i)
  assert.match(definitions,/UNIQUE \(project_id, fingerprint\)/i)
  assert.match(definitions,/expires_at > approved_at/i)
  assert.match(definitions,/artifact_version > 0/i)
  assert.match(definitions,/policy_version > 0/i)
  assert.match(definitions,/provider_connection_version > 0/i)
  assert.match(definitions,/publish/i); assert.match(definitions,/send/i)
})

test('Tony graph and approval foreign keys prevent orphaned cross-domain persistence', async t => {
  const client = await isolatedClient(t); if (!client) return
  const { rows } = await client.query(`SELECT conrelid::regclass::text AS table_name,confrelid::regclass::text AS target
    FROM pg_constraint WHERE contype='f' AND conrelid IN
    ('public.tony_execution_plans'::regclass,'public.autopilot_action_approvals'::regclass)`)
  const links = new Set(rows.map(row => `${row.table_name}->${row.target}`))
  for (const link of ['tony_execution_plans->users','tony_execution_plans->projects','tony_execution_plans->marketing_campaigns','autopilot_action_approvals->tony_execution_plans','autopilot_action_approvals->users']) assert.ok(links.has(link), `missing FK ${link}`)
})
