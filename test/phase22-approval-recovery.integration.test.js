import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import pg from 'pg'
import { PHASE19 } from '../src/services/phase19Fixture.js'
import { approvalFingerprint } from '../src/tony/autopilotPolicy.js'
import { consumeApprovalEnvelope } from '../src/tony/approvalStore.js'

dotenv.config({ override: true })

async function verifiedPool(t) {
  const db = new pg.Pool({ connectionString: process.env.YEEYOO_TEST_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 10_000 })
  t.after(() => db.end())
  const { rows } = await db.query('SELECT current_database() name')
  assert.equal(rows[0]?.name, 'yeeyoo_phase13_test')
  return db
}

test('stale approval is denied durably and a freshly fingerprinted approval recovers safely', async t => {
  const db = await verifiedPool(t)
  const suffix = crypto.randomUUID(), campaignId = `p22-c-${suffix}`, artifactId = `p22-a-${suffix}`, planId = `p22-p-${suffix}`
  const policyId = `p22-pol-${suffix}`, staleId = `p22-stale-${suffix}`, freshId = `p22-fresh-${suffix}`
  const staleKey = `p22-stale-key-${suffix}`, freshKey = `p22-fresh-key-${suffix}`, nonce = crypto.randomUUID()
  const context = { userId: PHASE19.userId, projectId: PHASE19.projectId, campaignId, planId, artifactId, artifactVersion: 1, budget: 1, currency: 'NOK', channels: ['mock'], providerConnected: true, providerConnectionId: 'mock', providerConnectionVersion: 1, approvalNonce: nonce }
  try {
    await db.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,status,context) VALUES($1,$2,$3,'P22','draft','{}')`, [campaignId, PHASE19.userId, PHASE19.projectId])
    await db.query(`INSERT INTO marketing_artifacts(id,root_id,user_id,project_id,campaign_id,type,purpose,content,provenance,provider,model) VALUES($1,$1,$2,$3,$4,'copy','P22','{}','{}','mock','mock')`, [artifactId, PHASE19.userId, PHASE19.projectId, campaignId])
    await db.query(`INSERT INTO tony_execution_plans(id,user_id,project_id,campaign_id,objective,status,graph) VALUES($1,$2,$3,$4,'P22','planned','{}')`, [planId, PHASE19.userId, PHASE19.projectId, campaignId])
    await db.query(`INSERT INTO autopilot_policies(id,project_id,campaign_id,level,channels,max_budget,currency,created_by) VALUES($1,$2,$3,3,'["mock"]',1,'NOK',$4)`, [policyId, PHASE19.projectId, campaignId, PHASE19.userId])
    const staleFingerprint = approvalFingerprint({ ...context, action: 'publish', policyVersion: 1 })
    await db.query(`INSERT INTO autopilot_action_approvals(id,user_id,project_id,campaign_id,plan_id,artifact_id,artifact_version,action,policy_version,provider_connection_id,provider_connection_version,fingerprint,nonce,approved_by_user_id,approved_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,'publish',1,'mock',1,$7,$8,$2,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour')`, [staleId, PHASE19.userId, PHASE19.projectId, campaignId, planId, artifactId, staleFingerprint, nonce])
    await db.query('UPDATE autopilot_policies SET version=2 WHERE id=$1', [policyId])

    const stale = await consumeApprovalEnvelope({ approvalId: staleId, userId: PHASE19.userId, projectId: PHASE19.projectId, campaignId, action: 'publish', context, idempotencyKey: staleKey, db })
    assert.equal(stale.allowed, false)
    assert.equal(stale.code, 'APPROVED_STATE_CHANGED')
    const staleState = await db.query('SELECT consumed_at FROM autopilot_action_approvals WHERE id=$1', [staleId])
    assert.equal(staleState.rows[0].consumed_at, null)
    const staleAudit = await db.query('SELECT decision,decision_code FROM autopilot_action_audit WHERE project_id=$1 AND idempotency_key=$2', [PHASE19.projectId, staleKey])
    assert.deepEqual(staleAudit.rows[0], { decision: 'denied', decision_code: 'APPROVED_STATE_CHANGED' })

    const freshNonce = crypto.randomUUID(), freshContext = { ...context, approvalNonce: freshNonce }
    const freshFingerprint = approvalFingerprint({ ...freshContext, action: 'publish', policyVersion: 2 })
    await db.query(`INSERT INTO autopilot_action_approvals(id,user_id,project_id,campaign_id,plan_id,artifact_id,artifact_version,action,policy_version,provider_connection_id,provider_connection_version,fingerprint,nonce,approved_by_user_id,approved_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,'publish',2,'mock',1,$7,$8,$2,NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour')`, [freshId, PHASE19.userId, PHASE19.projectId, campaignId, planId, artifactId, freshFingerprint, freshNonce])
    const fresh = await consumeApprovalEnvelope({ approvalId: freshId, userId: PHASE19.userId, projectId: PHASE19.projectId, campaignId, action: 'publish', context: freshContext, idempotencyKey: freshKey, db })
    assert.equal(fresh.allowed, true)
    const freshState = await db.query('SELECT consumed_at FROM autopilot_action_approvals WHERE id=$1', [freshId])
    assert.ok(freshState.rows[0].consumed_at)
  } finally {
    await db.query('DELETE FROM autopilot_action_audit WHERE plan_id=$1', [planId]).catch(() => {})
    await db.query('DELETE FROM autopilot_action_approvals WHERE id=ANY($1)', [[staleId, freshId]]).catch(() => {})
    await db.query('DELETE FROM autopilot_policies WHERE id=$1', [policyId]).catch(() => {})
    await db.query('DELETE FROM tony_execution_plans WHERE id=$1', [planId]).catch(() => {})
    await db.query('DELETE FROM marketing_artifacts WHERE id=$1', [artifactId]).catch(() => {})
    await db.query('DELETE FROM marketing_campaigns WHERE id=$1', [campaignId]).catch(() => {})
  }
})
