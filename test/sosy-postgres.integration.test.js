import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config({override:true})
const EXPECTED='yeeyoo_phase13_test'
const ALPHA_USER='00000000-0000-4000-8000-000000000001'
const ALPHA_PROJECT='10000000-0000-4000-8000-000000000001'
const BETA_USER='00000000-0000-4000-8000-000000000002'

async function transaction(t){
  assert.ok(process.env.YEEYOO_TEST_DATABASE_URL,'test DB URL required')
  const client=new pg.Client({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10_000})
  await client.connect();t.after(()=>client.end());const identity=await client.query('SELECT current_database() AS name');assert.equal(identity.rows[0]?.name,EXPECTED,'refusing any other DB')
  await client.query('BEGIN');t.after(()=>client.query('ROLLBACK').catch(()=>{}));return client
}

test('Sosy delegation persists for its owned project and rejects a foreign tenant binding',async t=>{
  const db=await transaction(t),id=`sosy-pg-${crypto.randomUUID()}`
  const valid=await db.query(`INSERT INTO sosy_delegations
    (id,user_id,project_id,task_type,objective,channels,conversation_language,output_language)
    VALUES($1,$2,$3,'content.create','PostgreSQL proof','["instagram"]','nb','pt-BR') RETURNING status`,[id,ALPHA_USER,ALPHA_PROJECT])
  assert.equal(valid.rows[0]?.status,'assigned')
  await db.query('SAVEPOINT cross_tenant')
  await assert.rejects(db.query(`INSERT INTO sosy_delegations
    (id,user_id,project_id,task_type,objective,channels,conversation_language,output_language)
    VALUES($1,$2,$3,'content.create','Foreign tenant','["instagram"]','nb','en')`,[`foreign-${crypto.randomUUID()}`,BETA_USER,ALPHA_PROJECT]),error=>error.code==='23503')
  await db.query('ROLLBACK TO SAVEPOINT cross_tenant')
})

test('social interactions deduplicate provider replay and reject cross-tenant ownership',async t=>{
  const db=await transaction(t),providerId=`phase28-${crypto.randomUUID()}`
  const insert=`INSERT INTO social_engagement_interactions
    (id,user_id,project_id,provider,provider_account_id,provider_interaction_id,kind,body,occurred_at,classification)
    VALUES($1,$2,$3,'meta','fixture',$4,'comment','How much does this cost?',NOW(),'{"category":"LEAD"}')
    ON CONFLICT(user_id,project_id,provider,provider_account_id,provider_interaction_id) DO UPDATE SET observed_metrics=EXCLUDED.observed_metrics RETURNING id`
  const first=await db.query(insert,[crypto.randomUUID(),ALPHA_USER,ALPHA_PROJECT,providerId])
  const replay=await db.query(insert,[crypto.randomUUID(),ALPHA_USER,ALPHA_PROJECT,providerId])
  assert.equal(replay.rows[0]?.id,first.rows[0]?.id)
  await db.query('SAVEPOINT cross_tenant')
  await assert.rejects(db.query(insert,[crypto.randomUUID(),BETA_USER,ALPHA_PROJECT,`${providerId}-foreign`]),error=>error.code==='23503')
  await db.query('ROLLBACK TO SAVEPOINT cross_tenant')
})
