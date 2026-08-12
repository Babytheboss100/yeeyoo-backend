import crypto from 'crypto'
import { pool } from '../db.js'
import { bumpStreak } from '../lib/streak.js'

export function classifyPublish(post, previousAttempt) {
  if (!post) return 'missing'
  if (post.status === 'published' || previousAttempt?.status === 'published') return 'idempotent'
  if (!['approved', 'publish_failed'].includes(post.status)) return 'not-approved'
  return 'publish'
}

export async function publishPost({ userId, postId, adapter, db = pool, now = new Date() }) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query('SELECT * FROM posts WHERE id=$1 AND user_id=$2 FOR UPDATE', [postId, userId])
    const post = found.rows[0]
    if (classifyPublish(post) === 'missing') { await client.query('ROLLBACK'); return { status: 404, body: { error: 'Post ikke funnet' } } }
    if (classifyPublish(post) === 'idempotent') { await client.query('ROLLBACK'); return { status: 200, body: { post, idempotent: true } } }
    if (classifyPublish(post) === 'not-approved') { await client.query('ROLLBACK'); return { status: 409, body: { error: 'Post må godkjennes før publisering' } } }
    const key = `${userId}:${postId}`
    const previous = await client.query('SELECT * FROM publish_attempts WHERE idempotency_key=$1', [key])
    if (classifyPublish(post, previous.rows[0]) === 'idempotent') { await client.query('ROLLBACK'); return { status: 200, body: { post, attempt: previous.rows[0], idempotent: true } } }
    const attemptId = previous.rows[0]?.id || crypto.randomUUID()
    await client.query(`INSERT INTO publish_attempts (id,user_id,project_id,post_id,adapter,idempotency_key,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'running',NOW(),NOW()) ON CONFLICT (idempotency_key) DO UPDATE SET status='running',error=NULL,updated_at=NOW()`,
      [attemptId, userId, post.project_id, post.id, adapter.id, key])
    try {
      const result = await adapter.publish({ post, idempotencyKey: key })
      const updated = await client.query("UPDATE posts SET status='published',published_at=$1 WHERE id=$2 RETURNING *", [now, post.id])
      await client.query("UPDATE publish_attempts SET status='published',provider_result=$1,updated_at=NOW() WHERE id=$2", [JSON.stringify(result), attemptId])
      await client.query('COMMIT')
      await bumpStreak(userId, { eventKey: `publish:${post.id}`, occurredAt: now, db })
      return { status: 200, body: { post: updated.rows[0], result, idempotent: false } }
    } catch (error) {
      await client.query("UPDATE posts SET status='publish_failed' WHERE id=$1", [post.id])
      await client.query("UPDATE publish_attempts SET status='failed',error=$1,updated_at=NOW() WHERE id=$2", [error.message, attemptId])
      await client.query('COMMIT')
      return { status: 502, body: { error: 'Publisering feilet', code: 'PUBLISH_FAILED' } }
    }
  } finally { client.release() }
}
