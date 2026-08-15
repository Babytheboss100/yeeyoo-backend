import crypto from 'node:crypto'
import { pool } from '../db.js'
import { recordAIUsage } from './aiUsageLedger.js'
import { buildDailyBrief, buildReplyDraft, classifyInteraction, normalizeInteraction, operatingModeForPolicy } from './socialEngagement.js'

export async function ingestInteraction({userId,projectId,input,db=pool}) {
  const item=normalizeInteraction(input); const classification=classifyInteraction(item.body); const id=crypto.randomUUID()
  const {rows}=await db.query(`INSERT INTO social_engagement_interactions
    (id,user_id,project_id,provider,provider_account_id,provider_interaction_id,kind,author_ref,body,occurred_at,classification,observed_metrics)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(user_id,project_id,provider,provider_account_id,provider_interaction_id) DO UPDATE SET observed_metrics=EXCLUDED.observed_metrics
    RETURNING *`,[id,userId,projectId,item.provider,item.providerAccountId,item.providerInteractionId,item.kind,item.authorRef,item.body,item.occurredAt,classification,item.observedMetrics])
  const row=rows[0]
  if(classification.lead) await db.query(`INSERT INTO social_engagement_leads(id,user_id,project_id,interaction_id,source,channel,score,reason,confidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,project_id,interaction_id) DO NOTHING`,[crypto.randomUUID(),userId,projectId,row.id,item.provider,item.kind,Math.round(classification.confidence*100),'commercial_intent',classification.confidence])
  if(classification.requires_human) await db.query(`INSERT INTO social_engagement_escalations(id,user_id,project_id,interaction_id,reason,target) VALUES($1,$2,$3,$4,$5,'PROJECT_OWNER') ON CONFLICT(user_id,project_id,interaction_id,reason) DO NOTHING`,[crypto.randomUUID(),userId,projectId,row.id,classification.promptInjection?'PROMPT_INJECTION':'HUMAN_REVIEW'])
  return row
}

export async function draftReply({userId,projectId,interactionId,idempotencyKey,brandName,db=pool}) {
  const found=await db.query(`SELECT * FROM social_engagement_interactions WHERE id=$1 AND user_id=$2 AND project_id=$3`,[interactionId,userId,projectId]); if(!found.rows[0]) return null
  const draft=buildReplyDraft({interaction:found.rows[0],classification:found.rows[0].classification,brandName})
  const {rows}=await db.query(`INSERT INTO social_engagement_reply_drafts(id,user_id,project_id,interaction_id,body,model,idempotency_key)
    VALUES($1,$2,$3,$4,$5,'deterministic-local-sosy-v1',$6) ON CONFLICT(user_id,project_id,idempotency_key) DO UPDATE SET id=social_engagement_reply_drafts.id RETURNING *`,[crypto.randomUUID(),userId,projectId,interactionId,draft.body,idempotencyKey])
  await recordAIUsage({userId,projectId,specialist:'social',operation:'sosy.reply_draft',provider:'local',model:'deterministic-local-sosy-v1',idempotencyKey:`sosy:${idempotencyKey}`,billable:false,metadata:{interactionId,sourceBodyTreatedAsUntrusted:true}},{db}).catch(()=>{})
  return {...rows[0],requiresHuman:draft.requiresHuman,executionStarted:false}
}

export async function getEngagementOverview({userId,projectId,date=new Date().toISOString().slice(0,10),db=pool}) {
  const [interactions,policy]=await Promise.all([db.query(`SELECT * FROM social_engagement_interactions WHERE user_id=$1 AND project_id=$2 AND occurred_at >= $3::date AND occurred_at < $3::date + interval '1 day' ORDER BY occurred_at DESC`,[userId,projectId,date]),db.query(`SELECT COALESCE(MAX(level),0)::int AS level FROM autopilot_policies WHERE project_id=$1`,[projectId])])
  return {interactions:interactions.rows,operatingMode:operatingModeForPolicy(policy.rows[0]?.level),dailyBrief:buildDailyBrief(interactions.rows,date)}
}
