import crypto from 'crypto'
import { pool } from '../db.js'

const STATE_TTL_MS = 10 * 60 * 1000
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')

export async function createLoginOauthState(provider, returnTo, client = pool) {
  if (!['google', 'vipps'].includes(provider)) throw new Error('Unsupported login OAuth provider')
  const state = crypto.randomBytes(32).toString('base64url')
  await client.query(
    `INSERT INTO login_oauth_states (id, state_hash, provider, return_to, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [crypto.randomUUID(), digest(state), provider, returnTo || null, new Date(Date.now() + STATE_TTL_MS)]
  )
  return state
}

export async function consumeLoginOauthState(provider, state, client = pool) {
  if (!state || !['google', 'vipps'].includes(provider)) return null
  const { rows } = await client.query(
    `DELETE FROM login_oauth_states
      WHERE state_hash=$1 AND provider=$2 AND expires_at > NOW()
      RETURNING return_to, created_at`,
    [digest(state), provider]
  )
  return rows[0] || null
}

export const loginOauthStateConstants = { STATE_TTL_MS }
