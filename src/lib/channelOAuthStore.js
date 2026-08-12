import crypto from 'node:crypto'
import { pool } from '../db.js'

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

export async function createChannelOAuthState({ userId, projectId, provider, redirectUri, ttlSeconds = 600, db = pool, state = crypto.randomBytes(32).toString('base64url') }) {
  if (!userId || !projectId || !provider || !redirectUri) throw new TypeError('Complete OAuth context is required')
  await db.query(
    `INSERT INTO channel_oauth_states (id,state_hash,user_id,project_id,provider,redirect_uri,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() + ($7 * INTERVAL '1 second'))`,
    [crypto.randomUUID(), hash(state), userId, projectId, provider, redirectUri, ttlSeconds]
  )
  return state
}

// Atomic delete makes the state one-time even when callbacks race.
export async function consumeChannelOAuthState({ state, projectId, provider, db = pool }) {
  if (!state || !projectId || !provider) return null
  const { rows } = await db.query(
    `DELETE FROM channel_oauth_states
     WHERE state_hash=$1 AND project_id=$2 AND provider=$3 AND expires_at>NOW()
     RETURNING user_id,project_id,provider,redirect_uri`,
    [hash(state), projectId, provider]
  )
  return rows[0] || null
}

export async function upsertMockChannelConnection({ userId, projectId, provider, externalAccountId, scopes = [], db = pool }) {
  const { rows } = await db.query(
    `INSERT INTO channel_connections (id,user_id,project_id,provider,provider_account_id,status,scopes,capabilities,last_verified_at)
     VALUES ($1,$2,$3,$4,$5,'connected',$6,'{}'::jsonb,NOW())
     ON CONFLICT (project_id,provider,provider_account_id) DO UPDATE SET
       user_id=EXCLUDED.user_id,status='connected',scopes=EXCLUDED.scopes,last_verified_at=NOW(),last_error_code=NULL,last_error_at=NULL,updated_at=NOW()
     RETURNING *`,
    [crypto.randomUUID(), userId, projectId, provider, externalAccountId, scopes]
  )
  return rows[0]
}

export async function revokeChannelConnection({ id, userId, projectId, db = pool }) {
  const { rows } = await db.query(
    `UPDATE channel_connections SET status='revoked',updated_at=NOW()
     WHERE id=$1 AND user_id=$2 AND project_id=$3 RETURNING *`,
    [id, userId, projectId]
  )
  return rows[0] || null
}

export async function listChannelConnections({ userId, projectId, db = pool }) {
  const { rows } = await db.query(`SELECT id,user_id,project_id,provider,provider_account_id,status,scopes,capabilities,
    last_verified_at,last_error_code,last_error_at,created_at,updated_at FROM channel_connections
    WHERE user_id=$1 AND project_id=$2 ORDER BY provider,created_at`, [userId, projectId])
  return rows
}
