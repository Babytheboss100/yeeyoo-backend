import crypto from 'crypto'
import { pool } from '../db.js'

export const ACCESS_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-yeeyoo_session' : 'yeeyoo_session'
export const REFRESH_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-yeeyoo_refresh' : 'yeeyoo_refresh'
const ACCESS_TTL_MS = 15 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const EXCHANGE_TTL_MS = 5 * 60 * 1000

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const randomToken = () => crypto.randomBytes(32).toString('base64url')

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const at = part.indexOf('=')
    if (at < 0) return ['', '']
    const key = part.slice(0, at).trim()
    try { return [key, decodeURIComponent(part.slice(at + 1).trim())] }
    catch { return ['', ''] }
  }).filter(([key]) => key))
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  }
}

export function setSessionCookies(res, session) {
  res.cookie(ACCESS_COOKIE, session.accessToken, cookieOptions(ACCESS_TTL_MS))
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(REFRESH_TTL_MS))
  res.set('Cache-Control', 'no-store')
}

export function clearSessionCookies(res) {
  const options = cookieOptions(0)
  res.clearCookie(ACCESS_COOKIE, options)
  res.clearCookie(REFRESH_COOKIE, options)
  res.set('Cache-Control', 'no-store')
}

export async function createSession(userId, req, client = pool) {
  const accessToken = randomToken()
  const refreshToken = randomToken()
  const familyId = crypto.randomUUID()
  await client.query(
    `INSERT INTO auth_sessions
       (id, user_id, access_hash, refresh_hash, family_id, access_expires_at,
        refresh_expires_at, user_agent, ip_address)
     VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '15 minutes',NOW() + INTERVAL '30 days',$6,$7)`,
    [crypto.randomUUID(), userId, digest(accessToken), digest(refreshToken), familyId,
      (req.headers['user-agent'] || '').slice(0, 500), req.ip || null]
  )
  return { accessToken, refreshToken }
}

export async function findSession(accessToken, client = pool) {
  if (!accessToken) return null
  const { rows } = await client.query(
    `SELECT s.id AS session_id, u.id, u.name, u.email, u.is_admin
       FROM auth_sessions s JOIN users u ON u.id::text=s.user_id::text
      WHERE s.access_hash=$1 AND s.revoked_at IS NULL AND s.access_expires_at > NOW()`,
    [digest(accessToken)]
  )
  return rows[0] || null
}

export async function rotateSession(refreshToken, req, db = pool) {
  if (!refreshToken) return null
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT * FROM auth_sessions WHERE refresh_hash=$1 FOR UPDATE`, [digest(refreshToken)]
    )
    const current = rows[0]
    if (!current || current.revoked_at || new Date(current.refresh_expires_at) <= new Date()) {
      // A reused/revoked refresh token invalidates its whole rotation family.
      if (current?.family_id) {
        await client.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE family_id=$1', [current.family_id])
      }
      await client.query('COMMIT')
      return null
    }
    await client.query('UPDATE auth_sessions SET revoked_at=NOW(), last_used_at=NOW() WHERE id=$1', [current.id])
    const next = await createSession(current.user_id, req, client)
    await client.query(
      `UPDATE auth_sessions SET family_id=$1 WHERE refresh_hash=$2`,
      [current.family_id, digest(next.refreshToken)]
    )
    await client.query('COMMIT')
    return next
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function revokeSession({ accessToken, refreshToken }, client = pool) {
  const hashes = [accessToken, refreshToken].filter(Boolean).map(digest)
  if (!hashes.length) return
  await client.query(
    `WITH matched_families AS (
       SELECT family_id FROM auth_sessions
       WHERE access_hash = ANY($1::text[]) OR refresh_hash = ANY($1::text[])
     )
     UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW())
     WHERE family_id IN (SELECT family_id FROM matched_families)`, [hashes]
  )
}

export async function createExchangeCode(userId, client = pool) {
  const code = randomToken()
  await client.query(
    `INSERT INTO auth_exchange_codes (id,user_id,code_hash,expires_at)
     VALUES ($1,$2,$3,NOW() + INTERVAL '5 minutes')`,
    [crypto.randomUUID(), userId, digest(code)]
  )
  return code
}

export async function consumeExchangeCode(code, req, db = pool) {
  if (!code || typeof code !== 'string') return null
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `DELETE FROM auth_exchange_codes
        WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING user_id`, [digest(code)]
    )
    if (!rows[0]) {
      await client.query('COMMIT')
      return null
    }
    const session = await createSession(rows[0].user_id, req, client)
    const user = await client.query('SELECT id,name,email,is_admin FROM users WHERE id=$1', [rows[0].user_id])
    await client.query('COMMIT')
    return { session, user: user.rows[0] }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export const sessionConstants = { ACCESS_TTL_MS, REFRESH_TTL_MS, EXCHANGE_TTL_MS }
