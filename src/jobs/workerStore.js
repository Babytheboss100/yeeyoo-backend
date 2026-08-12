import { pool } from '../db.js'

const decode = row => row && ({
  id: row.id, userId: row.user_id, projectId: row.project_id, kind: row.kind,
  provider: row.provider, model: row.model, status: row.status, input: row.input,
  retryCount: row.retry_count, maxRetries: row.max_retries, timeoutMs: row.timeout_ms,
  leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
})

// PostgreSQL SKIP LOCKED makes claims exclusive across worker processes.
export async function claimNextJob({ workerId, kinds, leaseSeconds = 90, db = pool }) {
  if (!workerId || !Array.isArray(kinds) || !kinds.length) throw new TypeError('workerId and kinds are required')
  const { rows } = await db.query(`WITH candidate AS (
      SELECT id FROM ai_jobs
      WHERE status='queued' AND available_at<=NOW() AND kind=ANY($1::text[])
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE ai_jobs j SET status='running',started_at=COALESCE(started_at,NOW()),
      lease_owner=$2,lease_expires_at=NOW()+($3*INTERVAL '1 second'),last_heartbeat_at=NOW(),updated_at=NOW()
    FROM candidate WHERE j.id=candidate.id RETURNING j.*`, [kinds, workerId, leaseSeconds])
  return decode(rows[0]) || null
}

export async function heartbeatJob({ id, workerId, leaseSeconds = 90, db = pool }) {
  const { rowCount } = await db.query(`UPDATE ai_jobs SET lease_expires_at=NOW()+($3*INTERVAL '1 second'),
    last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running' AND lease_owner=$2`, [id, workerId, leaseSeconds])
  return rowCount === 1
}

export async function completeClaimedJob({ id, workerId, artifacts = [], usage = {}, db = pool }) {
  const { rows } = await db.query(`UPDATE ai_jobs SET status='succeeded',artifacts=$3,usage=$4,error=NULL,
    finished_at=NOW(),lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
    WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING *`, [id, workerId, JSON.stringify(artifacts), JSON.stringify(usage)])
  return decode(rows[0]) || null
}

export async function failClaimedJob({ id, workerId, error, retryable = true, db = pool }) {
  const safeError = { code: String(error?.code || 'WORKER_ERROR').slice(0, 80), message: error?.publicMessage ? String(error.publicMessage).slice(0, 500) : 'Worker failed', retryable }
  const { rows } = await db.query(`UPDATE ai_jobs SET
    status=CASE WHEN $3 AND retry_count<max_retries THEN 'queued' ELSE 'failed' END,
    retry_count=retry_count+1,error=$4,
    available_at=CASE WHEN $3 THEN NOW()+(LEAST(300,POWER(2,retry_count))*INTERVAL '1 second') ELSE available_at END,
    finished_at=CASE WHEN $3 AND retry_count<max_retries THEN NULL ELSE NOW() END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
    WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING *`, [id, workerId, retryable, JSON.stringify(safeError)])
  return decode(rows[0]) || null
}

export async function recoverExpiredJobs({ db = pool } = {}) {
  const { rows } = await db.query(`UPDATE ai_jobs SET
    status=CASE WHEN retry_count<max_retries THEN 'queued' ELSE 'failed' END,
    retry_count=retry_count+1,error=jsonb_build_object('code','LEASE_EXPIRED','message','Worker lease expired','retryable',retry_count<max_retries),
    available_at=NOW(),finished_at=CASE WHEN retry_count<max_retries THEN NULL ELSE NOW() END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
    WHERE status='running' AND lease_expires_at<NOW() RETURNING id,status`)
  return rows
}

export async function cancelOwnedJob({ id, userId, projectId, db = pool }) {
  const { rows } = await db.query(`UPDATE ai_jobs SET status='cancelled',finished_at=NOW(),lease_owner=NULL,
    lease_expires_at=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND project_id=$3
    AND status IN ('queued','running') RETURNING *`, [id, userId, projectId])
  return decode(rows[0]) || null
}
