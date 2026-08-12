import crypto from 'crypto'
import { pool } from '../db.js'

export async function beginPublishAttempt({ userId, projectId, accountId, platform, idempotencyKey }, client = pool) {
  const id = crypto.randomUUID()
  const { rows } = await client.query(
    `INSERT INTO meta_publish_attempts
       (id,user_id,project_id,account_id,platform,idempotency_key,status)
     VALUES ($1,$2,$3,$4,$5,$6,'running')
     ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING *`,
    [id, userId, projectId, accountId, platform, idempotencyKey]
  )
  if (rows[0]) return { attempt: rows[0], duplicate: false }
  const existing = await client.query(
    'SELECT * FROM meta_publish_attempts WHERE user_id=$1 AND idempotency_key=$2',
    [userId, idempotencyKey]
  )
  return { attempt: existing.rows[0], duplicate: true }
}

export async function finishPublishAttempt(id, { status, result, error }, client = pool) {
  await client.query(
    `UPDATE meta_publish_attempts SET status=$2, provider_result=$3,
       error_code=$4, error_message=$5, updated_at=NOW() WHERE id=$1`,
    [id, status, result || null, error?.code || null, error?.message || null]
  )
}
