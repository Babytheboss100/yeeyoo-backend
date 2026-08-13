import test from 'node:test'
import assert from 'node:assert/strict'
import dotenv from 'dotenv'
import pg from 'pg'
import {createSession,findSession,revokeSession} from '../src/lib/session.js'

dotenv.config({override:true})
const EXPECTED='yeeyoo_phase13_test'
async function client(t){
  assert.ok(process.env.YEEYOO_TEST_DATABASE_URL,'test DB URL required')
  const c=new pg.Client({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10_000})
  await c.connect();t.after(()=>c.end());const {rows}=await c.query('SELECT current_database() name');assert.equal(rows[0]?.name,EXPECTED,'refusing any other DB');return c
}

test('approval envelopes have composite tenant bindings across every referenced domain',async t=>{
  const c=await client(t)
  const {rows}=await c.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid='autopilot_action_approvals'::regclass ORDER BY conname`)
  const sql=rows.map(r=>`${r.conname} ${r.definition}`).join('\n')
  for(const invariant of [
    /FOREIGN KEY \(project_id, user_id\) REFERENCES projects\(id, user_id\)/i,
    /FOREIGN KEY \(campaign_id, project_id, user_id\) REFERENCES marketing_campaigns\(id, project_id, user_id\)/i,
    /FOREIGN KEY \(artifact_id, project_id, user_id\) REFERENCES marketing_artifacts\(id, project_id, user_id\)/i,
    /FOREIGN KEY \(plan_id, project_id, user_id\) REFERENCES tony_execution_plans\(id, project_id, user_id\)/i,
  ]) assert.match(sql,invariant)
  const column=await c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='autopilot_action_approvals' AND column_name='user_id'`)
  assert.equal(column.rows[0]?.is_nullable,'NO')
})

test('database rejects cross-project approval envelope even when every referenced ID exists',async t=>{
  const c=await client(t);await c.query('BEGIN');t.after(()=>c.query('ROLLBACK').catch(()=>{}))
  const tenantA='00000000-0000-4000-8000-000000000001',projectA='10000000-0000-4000-8000-000000000001'
  const tenantB='00000000-0000-4000-8000-000000000002',projectB='20000000-0000-4000-8000-000000000001'
  const campaign=`phase15-campaign-${crypto.randomUUID()}`,artifact=`phase15-artifact-${crypto.randomUUID()}`
  await c.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,status,context) VALUES($1,$2,$3,'Phase15','draft','{}')`,[campaign,tenantA,projectA])
  await c.query(`INSERT INTO marketing_artifacts(id,root_id,user_id,project_id,campaign_id,type,purpose,content,provenance,provider,model)
    VALUES($1,$1,$2,$3,$4,'copy','Phase15','{}','{}','mock','mock')`,[artifact,tenantA,projectA,campaign])
  await assert.rejects(c.query(`INSERT INTO autopilot_action_approvals
    (id,user_id,project_id,campaign_id,artifact_id,artifact_version,action,policy_version,provider_connection_id,provider_connection_version,fingerprint,nonce,approved_by_user_id,expires_at)
    VALUES($1,$2,$3,$4,$5,1,'publish',1,'mock',1,$6,$7,$2,NOW()+INTERVAL '1 hour')`,
    [`phase15-${Date.now()}`,tenantB,projectB,campaign,artifact,'a'.repeat(64),crypto.randomUUID()]),error=>error.code==='23503')
})

test('authenticated persisted session resolves only its owner and revocation is immediate',async t=>{
  const c=await client(t);await c.query('BEGIN');t.after(()=>c.query('ROLLBACK').catch(()=>{}))
  const session=await createSession('00000000-0000-4000-8000-000000000001',{headers:{'user-agent':'phase15'},ip:'127.0.0.1'},c)
  const owner=await findSession(session.accessToken,c)
  assert.equal(owner?.id,'00000000-0000-4000-8000-000000000001')
  assert.notEqual(owner?.id,'00000000-0000-4000-8000-000000000002')
  await revokeSession({accessToken:session.accessToken},c)
  assert.equal(await findSession(session.accessToken,c),null)
})
