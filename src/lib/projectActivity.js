import crypto from 'node:crypto'
import { pool } from '../db.js'

export const ACTIVITY_TYPES = Object.freeze(['tony_plan_completed','artifact_awaiting_approval','job_failed','campaign_ready','provider_disconnected','content_published','performance_data_available','meta_connection_initiated','meta_connection_completed','meta_capability_verified','meta_reauth_required','sosy_delegation_created','sosy_draft_completed'])
export async function recordProjectActivity({ userId, projectId, eventType, subjectType = null, subjectId = null, summary, metadata = {}, dedupeKey = null, db = pool }) {
  if (!ACTIVITY_TYPES.includes(eventType) || !userId || !projectId || !summary) throw new TypeError('Valid scoped activity is required')
  const { rows } = await db.query(`INSERT INTO project_activity(id,user_id,project_id,event_type,subject_type,subject_id,summary,metadata,dedupe_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,project_id,dedupe_key)
    DO NOTHING RETURNING *`, [crypto.randomUUID(), userId, projectId, eventType, subjectType, subjectId, String(summary).slice(0, 240), JSON.stringify(metadata), dedupeKey])
  return rows[0] || null
}
export async function listProjectActivity({ userId, projectId, limit = 30, before = null, db = pool }) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30))
  const { rows } = await db.query(`SELECT id,event_type,subject_type,subject_id,summary,metadata,created_at FROM project_activity
    WHERE user_id=$1 AND project_id=$2 AND ($3::timestamptz IS NULL OR created_at<$3)
    ORDER BY created_at DESC LIMIT $4`, [userId, projectId, before, safeLimit])
  return rows
}
