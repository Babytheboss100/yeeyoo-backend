import crypto from 'node:crypto'
import { pool } from '../db.js'
import { authorizeAutopilot } from './autopilotPolicy.js'

export class ApprovalConsumeError extends Error { constructor(code,message){super(message);this.code=code} }

// The only persistence boundary that turns an approval into authority. The row
// is locked, revalidated against current context, consumed, and audited in one
// transaction. Callers execute the provider side effect only after `allowed`.
export async function consumeApprovalEnvelope({approvalId,userId,projectId,campaignId,action,context,idempotencyKey,now=Date.now(),db=pool}){
  if(!approvalId||!userId||!projectId||!campaignId||!action||!context||!idempotencyKey)throw new ApprovalConsumeError('APPROVAL_CONTEXT_REQUIRED','Complete authenticated approval context is required')
  if(context.userId!==userId||context.projectId!==projectId||context.campaignId!==campaignId)throw new ApprovalConsumeError('APPROVAL_SCOPE_MISMATCH','Authenticated context does not match action context')
  const client=await db.connect()
  try{
    await client.query('BEGIN')
    // Serialize identical action keys before checking the audit ledger. A plain
    // SELECT cannot prevent two concurrent transactions both observing absence.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${projectId}:${idempotencyKey}`])
    const duplicate=await client.query(`SELECT decision,decision_code FROM autopilot_action_audit WHERE project_id=$1 AND idempotency_key=$2 FOR UPDATE`,[projectId,idempotencyKey])
    if(duplicate.rows[0]){await client.query('COMMIT');return{allowed:false,duplicate:true,code:'ACTION_REPLAY_DENIED'}}
    const [approvalResult,policyResult]=await Promise.all([
      client.query(`SELECT * FROM autopilot_action_approvals WHERE id=$1 AND user_id=$2 AND project_id=$3 AND campaign_id=$4 FOR UPDATE`,[approvalId,userId,projectId,campaignId]),
      // Keep the policy version stable until the approval decision and audit are
      // committed. Otherwise a concurrent policy update can make a stale
      // approval appear current between this read and the consume write.
      client.query(`SELECT * FROM autopilot_policies WHERE project_id=$1 AND campaign_id=$2 FOR UPDATE`,[projectId,campaignId]),
    ])
    const approval=approvalResult.rows[0],policy=policyResult.rows[0]
    const decision=authorizeAutopilot({policy:{...policy,level:Number(policy?.level),version:Number(policy?.version),maxBudget:policy?.max_budget,projectId:policy?.project_id,campaignId:policy?.campaign_id},action,context,approval,now})
    if(decision.allowed){
      const consumed=await client.query(`UPDATE autopilot_action_approvals SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,[approvalId])
      if(!consumed.rows[0])throw new ApprovalConsumeError('APPROVAL_REPLAY_DENIED','Approval was already consumed or revoked')
    }
    await client.query(`INSERT INTO autopilot_action_audit(id,project_id,campaign_id,plan_id,action,decision,decision_code,idempotency_key,context_hash,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[crypto.randomUUID(),projectId,campaignId,context.planId||null,action,decision.allowed?'allowed':'denied',decision.code,idempotencyKey,crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex'),userId])
    await client.query('COMMIT')
    return{...decision,duplicate:false}
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
