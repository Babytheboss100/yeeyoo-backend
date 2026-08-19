import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import pg from 'pg'
import { ARTIFACT_CHECKSUM_VERSION, artifactContentChecksum } from '../src/marketing/artifacts.js'
import {PHASE19} from '../src/services/phase19Fixture.js'
import {approvalFingerprint} from '../src/tony/autopilotPolicy.js'
import {consumeApprovalEnvelope} from '../src/tony/approvalStore.js'

dotenv.config({override:true})
async function verifiedPool(t){const db=new pg.Pool({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},max:4,connectionTimeoutMillis:10_000});t.after(()=>db.end());const{rows}=await db.query('SELECT current_database() name');assert.equal(rows[0]?.name,'yeeyoo_phase13_test');return db}

test('seeded artifact lineage, tenant and approval version are internally consistent',async t=>{
  const db=await verifiedPool(t),{rows}=await db.query(`SELECT a.id,a.root_id,a.parent_id,a.user_id,a.project_id,a.campaign_id,a.artifact_version,a.status,d.decision,d.artifact_version decision_version
    FROM marketing_artifacts a LEFT JOIN marketing_approval_decisions d ON d.artifact_id=a.id AND d.user_id=a.user_id AND d.project_id=a.project_id
    WHERE a.root_id=$1 ORDER BY a.artifact_version`,[PHASE19.artifactRootId])
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.artifact_version),[1,2]);assert.equal(rows[1].parent_id,rows[0].id)
  assert.ok(rows.every(r=>r.user_id===PHASE19.userId&&r.project_id===PHASE19.projectId&&r.campaign_id===PHASE19.campaignId))
  assert.equal(rows[0].status,'archived');assert.equal(rows[1].status,'approved');assert.equal(rows[1].decision,'approved');assert.equal(rows[1].decision_version,2)
})

test('same idempotency key concurrent approval calls produce one authorization and one inert duplicate',async t=>{
  const db=await verifiedPool(t),suffix=crypto.randomUUID(),campaignId=`p21-c-${suffix}`,artifactId=`p21-a-${suffix}`,planId=`p21-p-${suffix}`,approvalId=`p21-ok-${suffix}`,nonce=crypto.randomUUID(),key=`same-${suffix}`
  const context={userId:PHASE19.userId,projectId:PHASE19.projectId,campaignId,planId,artifactId,artifactVersion:1,budget:1,currency:'NOK',channels:['mock'],providerConnected:true,providerConnectionId:'mock',providerConnectionVersion:1,approvalNonce:nonce}
  try{
    await db.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,status,context) VALUES($1,$2,$3,'P21','draft','{}')`,[campaignId,PHASE19.userId,PHASE19.projectId]);await db.query(`INSERT INTO marketing_artifacts(id,root_id,user_id,project_id,campaign_id,type,purpose,content,provenance,provider,model,checksum_version,content_checksum) VALUES($1,$1,$2,$3,$4,'copy','P21','{}','{}','mock','mock',$5,$6)`,[artifactId,PHASE19.userId,PHASE19.projectId,campaignId,ARTIFACT_CHECKSUM_VERSION,artifactContentChecksum({content:{},provenance:{}})]);await db.query(`INSERT INTO tony_execution_plans(id,user_id,project_id,campaign_id,objective,status,graph) VALUES($1,$2,$3,$4,'P21','planned','{}')`,[planId,PHASE19.userId,PHASE19.projectId,campaignId]);await db.query(`INSERT INTO autopilot_policies(id,project_id,campaign_id,level,channels,max_budget,currency,created_by) VALUES($1,$2,$3,3,'["mock"]',1,'NOK',$4)`,[`p21-pol-${suffix}`,PHASE19.projectId,campaignId,PHASE19.userId]);const fingerprint=approvalFingerprint({...context,action:'publish',policyVersion:1});await db.query(`INSERT INTO autopilot_action_approvals(id,user_id,project_id,campaign_id,plan_id,artifact_id,artifact_version,action,policy_version,provider_connection_id,provider_connection_version,fingerprint,nonce,approved_by_user_id,approved_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,'publish',1,'mock',1,$7,$8,$2,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour')`,[approvalId,PHASE19.userId,PHASE19.projectId,campaignId,planId,artifactId,fingerprint,nonce])
    const args={approvalId,userId:PHASE19.userId,projectId:PHASE19.projectId,campaignId,action:'publish',context,idempotencyKey:key,db}
    const results=await Promise.all([consumeApprovalEnvelope(args),consumeApprovalEnvelope(args)])
    assert.equal(results.filter(r=>r.allowed).length,1);assert.equal(results.filter(r=>r.duplicate&&r.code==='ACTION_REPLAY_DENIED').length,1)
    const audit=await db.query('SELECT count(*)::int count FROM autopilot_action_audit WHERE project_id=$1 AND idempotency_key=$2',[PHASE19.projectId,key]);assert.equal(audit.rows[0].count,1)
  }finally{await db.query('DELETE FROM autopilot_action_audit WHERE plan_id=$1',[planId]).catch(()=>{});await db.query('DELETE FROM autopilot_action_approvals WHERE id=$1',[approvalId]).catch(()=>{});await db.query('DELETE FROM autopilot_policies WHERE campaign_id=$1',[campaignId]).catch(()=>{});await db.query('DELETE FROM tony_execution_plans WHERE id=$1',[planId]).catch(()=>{});await db.query('DELETE FROM marketing_artifacts WHERE id=$1',[artifactId]).catch(()=>{});await db.query('DELETE FROM marketing_campaigns WHERE id=$1',[campaignId]).catch(()=>{})}
})
