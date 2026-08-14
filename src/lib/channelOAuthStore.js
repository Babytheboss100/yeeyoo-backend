import crypto from 'node:crypto'
import { pool } from '../db.js'
import { decryptToken, encryptToken } from './tokenCrypto.js'

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
export async function consumeChannelOAuthState({ state, userId, projectId, provider, db = pool }) {
  if (!state || !userId || !projectId || !provider) return null
  const { rows } = await db.query(
    `DELETE FROM channel_oauth_states
     WHERE state_hash=$1 AND user_id=$2 AND project_id=$3 AND provider=$4 AND expires_at>NOW()
     RETURNING user_id,project_id,provider,redirect_uri`,
    [hash(state), userId, projectId, provider]
  )
  return rows[0] || null
}

export async function getOwnedOAuthStateContext({ state, userId, provider, db = pool }) {
  if (!state || !userId || !provider) return null
  const { rows } = await db.query(`SELECT project_id FROM channel_oauth_states
    WHERE state_hash=$1 AND user_id=$2 AND provider=$3 AND expires_at>NOW()`, [hash(state),userId,provider])
  return rows[0] || null
}

export async function upsertLiveChannelConnection({ userId, projectId, provider, externalAccountId, scopes, accessToken, expiresAt, db = pool }) {
  const client = typeof db.connect === 'function' ? await db.connect() : db
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`INSERT INTO channel_connections(id,user_id,project_id,provider,provider_account_id,status,scopes,capabilities,last_verified_at)
      VALUES($1,$2,$3,$4,$5,'connected',$6,'{}'::jsonb,NOW()) ON CONFLICT(project_id,provider,provider_account_id)
      DO UPDATE SET user_id=EXCLUDED.user_id,status='connected',scopes=EXCLUDED.scopes,last_verified_at=NOW(),last_error_code=NULL,last_error_at=NULL,updated_at=NOW() RETURNING *`,
      [crypto.randomUUID(),userId,projectId,provider,externalAccountId,scopes])
    await client.query(`INSERT INTO channel_connection_credentials(connection_id,encrypted_access_token,token_expires_at)
      VALUES($1,$2,$3) ON CONFLICT(connection_id) DO UPDATE SET encrypted_access_token=EXCLUDED.encrypted_access_token,
      token_expires_at=EXCLUDED.token_expires_at,updated_at=NOW()`, [rows[0].id,encryptToken(accessToken),expiresAt])
    await client.query('COMMIT'); return rows[0]
  } catch(error) { await client.query('ROLLBACK'); throw error } finally { if(client!==db) client.release() }
}

export async function getConnectionCredential({ connectionId, userId, projectId, db = pool }) {
  const { rows } = await db.query(`SELECT c.encrypted_access_token,c.token_expires_at FROM channel_connection_credentials c
    JOIN channel_connections x ON x.id=c.connection_id WHERE c.connection_id=$1 AND x.user_id=$2 AND x.project_id=$3`, [connectionId,userId,projectId])
  return rows[0] ? { accessToken:decryptToken(rows[0].encrypted_access_token), expiresAt:rows[0].token_expires_at } : null
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

export async function getChannelConnection({ id, userId, projectId, provider, db = pool }) {
  const { rows } = await db.query(`SELECT id,user_id,project_id,provider,provider_account_id,status,scopes,capabilities,
    last_verified_at,last_error_code,last_error_at,created_at,updated_at FROM channel_connections
    WHERE id=$1 AND user_id=$2 AND project_id=$3 AND provider=$4`, [id,userId,projectId,provider])
  return rows[0] || null
}

export async function updateChannelConnectionVerification({ id,userId,projectId,status='connected',capabilities={},errorCode=null,db=pool }) {
  const { rows } = await db.query(`UPDATE channel_connections SET status=$1,capabilities=$2,last_verified_at=NOW(),
    last_error_code=$3,last_error_at=CASE WHEN $3 IS NULL THEN NULL ELSE NOW() END,updated_at=NOW()
    WHERE id=$4 AND user_id=$5 AND project_id=$6 RETURNING *`,
  [status,JSON.stringify(capabilities),errorCode,id,userId,projectId])
  return rows[0] || null
}

export async function listChannelConnections({ userId, projectId, db = pool }) {
  const { rows } = await db.query(`SELECT id,user_id,project_id,provider,provider_account_id,status,scopes,capabilities,
    last_verified_at,last_error_code,last_error_at,created_at,updated_at FROM channel_connections
    WHERE user_id=$1 AND project_id=$2 ORDER BY provider,created_at`, [userId, projectId])
  return rows
}
