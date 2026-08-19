const VIDEO_KIND = 'video.render'
const VIDEO_PROVIDER = 'composer-video'

function queryBoundary(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('Video lease store requires an injected PostgreSQL query boundary')
  return db.query.bind(db)
}

function decode(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    kind: row.kind,
    provider: row.provider,
    status: row.status,
    input: typeof row.input === 'string' ? JSON.parse(row.input) : structuredClone(row.input),
    artifacts: typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : structuredClone(row.artifacts || []),
    usage: typeof row.usage === 'string' ? JSON.parse(row.usage) : structuredClone(row.usage || {}),
    error: typeof row.error === 'string' ? JSON.parse(row.error) : structuredClone(row.error),
    retryCount: Number(row.retry_count || 0),
    maxRetries: Number(row.max_retries || 0),
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    lastHeartbeatAt: row.last_heartbeat_at || null,
    availableAt: row.available_at || null,
  })
}

function requireWorkerId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('workerId is invalid')
  return value
}

function requireLeaseSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 5 || value > 3600) throw new TypeError('leaseSeconds is invalid')
  return value
}

export function createPostgresVideoLeaseStore({ db } = {}) {
  const query = queryBoundary(db)
  return Object.freeze({
    kind: 'postgres-video-lease',

    async recoverExpired() {
      const { rows } = await query(`UPDATE ai_jobs SET
        status=CASE WHEN retry_count<max_retries THEN 'queued' ELSE 'failed' END,
        retry_count=retry_count+1,
        error=jsonb_build_object('code','LEASE_EXPIRED','message','Video worker lease expired','retryable',retry_count<max_retries),
        available_at=CASE WHEN retry_count<max_retries THEN NOW() ELSE available_at END,
        finished_at=CASE WHEN retry_count<max_retries THEN NULL ELSE NOW() END,
        input=jsonb_set(input,'{mediaEngine,version}',to_jsonb(((input #>> '{mediaEngine,version}')::bigint+1)),false),
        lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,updated_at=NOW()
        WHERE kind=$1 AND provider=$2 AND status='running' AND lease_expires_at<NOW()
        RETURNING *`, [VIDEO_KIND, VIDEO_PROVIDER])
      return rows.map(decode)
    },

    async claim({ workerId, leaseSeconds = 90 }) {
      const owner = requireWorkerId(workerId)
      const seconds = requireLeaseSeconds(leaseSeconds)
      const { rows } = await query(`WITH candidate AS (
          SELECT id FROM ai_jobs
          WHERE kind=$1 AND provider=$2 AND status='queued' AND available_at<=NOW()
          ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE ai_jobs j SET status='running',started_at=COALESCE(started_at,NOW()),
          lease_owner=$3,lease_expires_at=NOW()+($4*INTERVAL '1 second'),
          last_heartbeat_at=NOW(),updated_at=NOW(),error=NULL
        FROM candidate WHERE j.id=candidate.id RETURNING j.*`, [VIDEO_KIND, VIDEO_PROVIDER, owner, seconds])
      return decode(rows[0])
    },

    async heartbeat({ id, workerId, leaseSeconds = 90 }) {
      const owner = requireWorkerId(workerId)
      const seconds = requireLeaseSeconds(leaseSeconds)
      const { rows } = await query(`UPDATE ai_jobs SET
          lease_expires_at=NOW()+($3*INTERVAL '1 second'),last_heartbeat_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND kind=$4 AND provider=$5 AND status='running' AND lease_owner=$2
          AND lease_expires_at>=NOW() RETURNING id,status`, [id, owner, seconds, VIDEO_KIND, VIDEO_PROVIDER])
      return Boolean(rows[0])
    },

    async complete({ id, workerId, artifacts, usage }) {
      const owner = requireWorkerId(workerId)
      const { rows } = await query(`UPDATE ai_jobs SET status='succeeded',artifacts=$3::jsonb,usage=$4::jsonb,error=NULL,
          input=jsonb_set(input,'{mediaEngine,version}',to_jsonb(((input #>> '{mediaEngine,version}')::bigint+1)),false),
          finished_at=NOW(),lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,updated_at=NOW()
        WHERE id=$1 AND kind=$5 AND provider=$6 AND status='running' AND lease_owner=$2
          AND lease_expires_at>=NOW() RETURNING *`, [id, owner, JSON.stringify(artifacts), JSON.stringify(usage), VIDEO_KIND, VIDEO_PROVIDER])
      return decode(rows[0])
    },

    async fail({ id, workerId, error, retryable }) {
      const owner = requireWorkerId(workerId)
      const safe = { code: String(error?.code || 'VIDEO_RENDER_FAILED').slice(0, 80), message: 'Video render failed', retryable: Boolean(retryable) }
      const { rows } = await query(`UPDATE ai_jobs SET
          status=CASE WHEN $3 AND retry_count<max_retries THEN 'queued' ELSE 'failed' END,
          retry_count=retry_count+1,error=jsonb_set($4::jsonb,'{retryable}',to_jsonb($3 AND retry_count<max_retries),true),
          available_at=CASE WHEN $3 AND retry_count<max_retries THEN NOW()+(LEAST(300,POWER(2,retry_count))*INTERVAL '1 second') ELSE available_at END,
          finished_at=CASE WHEN $3 AND retry_count<max_retries THEN NULL ELSE NOW() END,
          input=jsonb_set(input,'{mediaEngine,version}',to_jsonb(((input #>> '{mediaEngine,version}')::bigint+1)),false),
          lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,updated_at=NOW()
        WHERE id=$1 AND kind=$5 AND provider=$6 AND status='running' AND lease_owner=$2
          AND lease_expires_at>=NOW() RETURNING *`, [id, owner, Boolean(retryable), JSON.stringify(safe), VIDEO_KIND, VIDEO_PROVIDER])
      return decode(rows[0])
    },

    async get(id) {
      const { rows } = await query('SELECT * FROM ai_jobs WHERE id=$1 AND kind=$2 AND provider=$3 LIMIT 1', [id, VIDEO_KIND, VIDEO_PROVIDER])
      return decode(rows[0])
    },
  })
}

export { VIDEO_KIND as POSTGRES_VIDEO_LEASE_KIND, VIDEO_PROVIDER as POSTGRES_VIDEO_LEASE_PROVIDER }
