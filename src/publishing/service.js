import crypto from 'crypto'
import { pool } from '../db.js'
import { bumpStreak } from '../lib/streak.js'
import { recordProjectActivity } from '../lib/projectActivity.js'
import { recordPerformanceEvent } from '../marketing/performanceEvents.js'

export function classifyPublish(post, previousAttempt) {
  if (!post) return 'missing'
  if (post.status === 'published' || previousAttempt?.status === 'published') return 'idempotent'
  if (!['approved', 'publish_failed'].includes(post.status)) return 'not-approved'
  return 'publish'
}

export async function publishPost({ userId, postId, projectId, campaignId, artifactId, artifactVersion, idempotencyKey, adapter, db = pool, now = new Date() }) {
  if (!userId || !postId || !projectId || !campaignId || !artifactId || !Number.isInteger(artifactVersion) || !String(idempotencyKey || '').trim()) {
    return { status: 400, body: { error: 'Complete execution scope and Idempotency-Key are required', code: 'EXECUTION_SCOPE_REQUIRED' } }
  }
  const executionKey = `${userId}:${postId}:${String(idempotencyKey).trim()}`
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query(`SELECT p.*, EXISTS(
      SELECT 1 FROM marketing_approval_decisions d JOIN marketing_artifacts a
        ON a.id=d.artifact_id AND a.user_id=d.user_id AND a.project_id=d.project_id
      WHERE d.user_id=p.user_id AND d.project_id=p.project_id AND d.campaign_id=p.campaign_id
        AND d.artifact_id=p.artifact_id AND d.artifact_version=p.artifact_version AND a.artifact_version=p.artifact_version
        AND d.decision='approved' AND d.revoked_at IS NULL
        AND d.checksum_version=a.checksum_version AND d.content_checksum=a.content_checksum
        AND d.output_checksum IS NOT DISTINCT FROM a.output_checksum
    ) AS approval_current FROM posts p WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE`, [postId, userId])
    const post = found.rows[0]
    if (!post) { await client.query('ROLLBACK'); return { status: 404, body: { error: 'Post not found' } } }
    if (post.project_id !== projectId || post.campaign_id !== campaignId || post.artifact_id !== artifactId || Number(post.artifact_version) !== artifactVersion) {
      await client.query('ROLLBACK'); return { status: 409, body: { error: 'Execution scope does not match queued artifact', code: 'EXECUTION_SCOPE_MISMATCH' } }
    }
    if (!post.approval_current) { await client.query('ROLLBACK'); return { status: 409, body: { error: 'Current artifact version is not approved', code: 'APPROVAL_REQUIRED' } } }
    if (classifyPublish(post) === 'idempotent') { await client.query('ROLLBACK'); return { status: 200, body: { post, idempotent: true } } }
    if (classifyPublish(post) === 'not-approved') { await client.query('ROLLBACK'); return { status: 409, body: { error: 'Post must be approved before mock execution', code: 'APPROVAL_REQUIRED' } } }
    const previous = await client.query('SELECT * FROM publish_attempts WHERE idempotency_key=$1 AND user_id=$2 AND project_id=$3 AND post_id=$4', [executionKey,userId,projectId,postId])
    if (classifyPublish(post, previous.rows[0]) === 'idempotent') { await client.query('ROLLBACK'); return { status: 200, body: { post, attempt: previous.rows[0], idempotent: true } } }
    const priorFailures=Number(previous.rows[0]?.provider_result?.attempts || 0)
    if(priorFailures>=2){
      await client.query('ROLLBACK')
      return {status:409,body:{error:'Mock retry limit reached',code:'RETRY_LIMIT_REACHED'}}
    }
    const attemptId = previous.rows[0]?.id || crypto.randomUUID()
    await client.query(`INSERT INTO publish_attempts (id,user_id,project_id,post_id,adapter,idempotency_key,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'running',NOW(),NOW()) ON CONFLICT (idempotency_key) DO UPDATE SET status='running',error=NULL,updated_at=NOW()`,
      [attemptId, userId, projectId, post.id, adapter.id, executionKey])
    try {
      const result = await adapter.publish({ post, idempotencyKey: executionKey })
      const updated = await client.query("UPDATE posts SET status='published',published_at=$1 WHERE id=$2 RETURNING *", [now, post.id])
      await client.query("UPDATE publish_attempts SET status='published',provider_result=$1,updated_at=NOW() WHERE id=$2", [JSON.stringify(result), attemptId])
      await recordProjectActivity({userId,projectId,eventType:'content_published',subjectType:'post',subjectId:post.id,summary:'Mock content published',metadata:{campaignId,artifactId,artifactVersion,provider:'mock-local'},dedupeKey:`publish:${attemptId}:succeeded`,db:client})
      await recordPerformanceEvent({userId,projectId,campaignId,artifactId,kind:'publish_succeeded',source:{provider:'mock-local',externalEventId:attemptId},metadata:{postId:post.id,artifactVersion}},{db:client,now:now.toISOString()})
      await client.query('COMMIT')
      await bumpStreak(userId, { eventKey: `publish:${post.id}`, occurredAt: now, db })
      return { status: 200, body: { post: updated.rows[0], result, idempotent: false } }
    } catch (error) {
      const attempts=priorFailures+1
      await client.query("UPDATE posts SET status='publish_failed' WHERE id=$1", [post.id])
      await client.query("UPDATE publish_attempts SET status='failed',error=$1,provider_result=$2,updated_at=NOW() WHERE id=$3", [String(error.message).slice(0,500),JSON.stringify({attempts}),attemptId])
      await recordProjectActivity({userId,projectId,eventType:'job_failed',subjectType:'post',subjectId:post.id,summary:'Mock publish failed',metadata:{campaignId,artifactId,artifactVersion,attempt:attempts},dedupeKey:`publish:${attemptId}:failed:${attempts}`,db:client})
      await recordPerformanceEvent({userId,projectId,campaignId,artifactId,kind:'publish_failed',source:{provider:'mock-local',externalEventId:`${attemptId}:failed:${attempts}`},metadata:{postId:post.id,artifactVersion}},{db:client,now:now.toISOString()})
      await client.query('COMMIT')
      return { status: 502, body: { error: 'Mock publish failed', code: 'PUBLISH_FAILED', retryable: attempts < 2 } }
    }
  } finally { client.release() }
}
