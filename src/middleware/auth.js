import jwt from 'jsonwebtoken'
import { pool } from '../db.js'
import { ACCESS_COOKIE, findSession, parseCookies } from '../lib/session.js'
import { requireTrustedOrigin } from './security.js'

export function createAuthMiddleware({lookup=findSession,env=process.env}={}){return async function authMiddleware(req, res, next) {
  const sessionToken = parseCookies(req.headers.cookie)[ACCESS_COOKIE]
  if (sessionToken) {
    try {
      const session = await lookup(sessionToken)
      if (!session) return res.status(401).json({ error: 'Økten er ugyldig eller utløpt', redirect: '/login' })
      req.user = { id: session.id, name: session.name, email: session.email, is_admin: session.is_admin }
      req.authSessionId = session.session_id
      return requireTrustedOrigin(req, res, next)
    } catch (e) {
      console.warn('[AUTH] session lookup failed:', e.message)
      return res.status(401).json({ error: 'Ugyldig økt', redirect: '/login' })
    }
  }

  // Transitional compatibility is explicit and disabled by default.
  if (env.AUTH_ALLOW_LEGACY_BEARER !== 'true') {
    return res.status(401).json({ error: 'Ikke autentisert', redirect: '/login' })
  }
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) {
    console.warn('[AUTH] 401 no token —', req.method, req.originalUrl)
    return res.status(401).json({ error: 'Ikke autentisert', redirect: '/login' })
  }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET)
    const { rows } = await pool.query(
      'SELECT id, name, email, is_admin FROM users WHERE id=$1', [decoded.id]
    )
    if (!rows[0]) {
      console.warn('[AUTH] 401 user not found — id:', decoded.id, req.method, req.originalUrl)
      return res.status(401).json({ error: 'Bruker finnes ikke lenger', redirect: '/login' })
    }
    req.user = rows[0]
    next()
  } catch (e) {
    console.warn('[AUTH] 401', e.name, '—', req.method, req.originalUrl)
    if (e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Økten har utløpt — logg inn på nytt', redirect: '/login' })
    res.status(401).json({ error: 'Ugyldig token', redirect: '/login' })
  }
}}
export const auth=createAuthMiddleware()
