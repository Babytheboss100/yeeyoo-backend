import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import pg from 'pg'
import { ARTIFACT_CHECKSUM_VERSION, artifactContentChecksum } from '../src/marketing/artifacts.js'
import {approvalFingerprint} from '../src/tony/autopilotPolicy.js'
import {consumeApprovalEnvelope} from '../src/tony/approvalStore.js'

dotenv.config({override:true})
const EXPECTED='yeeyoo_phase13_test',userId='00000000-0000-4000-8000-000000000001',projectId='10000000-0000-4000-8000-000000000001'
async function verifiedPool(t){const pool=new pg.Pool({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},max:4,connectionTimeoutMillis:10_000});t.after(()=>pool.end());const {rows}=await pool.query('SELECT current_database() name');assert.equal(rows[0]?.name,EXPECTED,'refusing any other DB');return pool}

test('real persistence permits exactly one consume and audits replay/failure recovery',async t=>{
  const db=await verifiedPool(t),suffix=crypto.randomUUID(),campaignId=`p19-c-${suffix}`,artifactId=`p19-a-${suffix}`,planId=`p19-p-${suffix}`,approvalId=`p19-ok-${suffix}`,nonce=crypto.randomUUID()
  const context={userId,projectId,campaignId,planId,artifactId,artifactVersion:1,budget:25,currency:'NOK',channels:['mock'],providerConnected:true,providerConnectionId:'mock-connection',providerConnectionVersion:1,approvalNonce:nonce}
  const fingerprint=approvalFingerprint({...context,action:'publish',policyVersion:1})
  try{
    await db.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,status,context) VALUES($1,$2,$3,'Phase19','draft','{}')`,[campaignId,userId,projectId])
    await db.query(`INSERT INTO marketing_artifacts(id,root_id,user_id,project_id,campaign_id,type,purpose,content,provenance,provider,model,checksum_version,content_checksum) VALUES($1,$1,$2,$3,$4,'copy','Phase19','{}','{}','mock','mock',$5,$6)`,[artifactId,userId,projectId,campaignId,ARTIFACT_CHECKSUM_VERSION,artifactContentChecksum({content:{},provenance:{}})])
    await db.query(`INSERT INTO tony_execution_plans(id,user_id,project_id,campaign_id,objective,status,graph) VALUES($1,$2,$3,$4,'Phase19','planned','{}')`,[planId,userId,projectId,campaignId])
    await db.query(`INSERT INTO autopilot_policies(id,project_id,campaign_id,level,channels,max_budget,currency,created_by) VALUES($1,$2,$3,3,'["mock"]',25,'NOK',$4)`,[`p19-policy-${suffix}`,projectId,campaignId,userId])
    await db.query(`INSERT INTO autopilot_action_approvals(id,user_id,project_id,campaign_id,plan_id,artifact_id,artifact_version,action,policy_version,provider_connection_id,provider_connection_version,fingerprint,nonce,approved_by_user_id,approved_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,'publish',1,'mock-connection',1,$7,$8,$2,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour')`,[approvalId,userId,projectId,campaignId,planId,artifactId,fingerprint,nonce])
    const attempts=await Promise.all([
      consumeApprovalEnvelope({approvalId,userId,projectId,campaignId,action:'publish',context,idempotencyKey:`first-${suffix}`,db}),
      consumeApprovalEnvelope({approvalId,userId,projectId,campaignId,action:'publish',context,idempotencyKey:`second-${suffix}`,db}),
    ])
    assert.equal(attempts.filter(result=>result.allowed).length,1)
    assert.equal(attempts.filter(result=>result.code==='APPROVAL_REPLAY_DENIED').length,1)
    const persisted=await db.query(`SELECT consumed_at FROM autopilot_action_approvals WHERE id=$1`,[approvalId]);assert.ok(persisted.rows[0]?.consumed_at)
    const audit=await db.query(`SELECT decision,decision_code FROM autopilot_action_audit WHERE plan_id=$1`,[planId]);assert.deepEqual(audit.rows.map(r=>r.decision_code).sort(),['APPROVAL_REPLAY_DENIED','AUTHORIZED'])
  }finally{
    await db.query('DELETE FROM autopilot_action_audit WHERE plan_id=$1',[planId]).catch(()=>{});await db.query('DELETE FROM autopilot_action_approvals WHERE id=$1',[approvalId]).catch(()=>{});await db.query('DELETE FROM autopilot_policies WHERE campaign_id=$1',[campaignId]).catch(()=>{});await db.query('DELETE FROM tony_execution_plans WHERE id=$1',[planId]).catch(()=>{});await db.query('DELETE FROM marketing_artifacts WHERE id=$1',[artifactId]).catch(()=>{});await db.query('DELETE FROM marketing_campaigns WHERE id=$1',[campaignId]).catch(()=>{})
  }
})
