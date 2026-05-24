// /api/oauth — OAuth-redirect-flyt for LinkedIn/Reddit/Pinterest.
//   GET /api/oauth/:provider/start    (authed) → { url } til provider
//   GET /api/oauth/:provider/callback (browser) → veksler kode, lagrer konto,
//                                       redirecter til frontend Connections
//
// state lagres i oauth_states (med user_id) og forbrukes ved callback (CSRF).

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { logAudit } from '../lib/audit.js'
import { PROVIDERS } from '../lib/oauthProviders.js'

const r = Router()
const STATE_TTL_MS = 10 * 60 * 1000

// GET /:provider/start
r.get('/:provider/start', auth, async (req, res) => {
  const provider = req.params.provider
  const p = PROVIDERS[provider]
  if (!p) return res.status(404).json({ error: 'Ukjent provider' })
  if (!p.enabled()) return res.status(503).json({ error: `${provider} OAuth er ikke konfigurert` })
  try {
    const state = crypto.randomBytes(16).toString('hex')
    await pool.query('INSERT INTO oauth_states (id, state, user_id, provider) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), state, req.user.id, provider])
    res.json({ url: p.authorizeUrl(state) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /:provider/callback (ingen JWT — Metas/providerns redirect i nettleseren)
r.get('/:provider/callback', async (req, res) => {
  const provider = req.params.provider
  const p = PROVIDERS[provider]
  const FRONT = process.env.FRONTEND_URL || 'https://app.yeeyoo.no'
  const done = (qs) => res.redirect(`${FRONT}/dashboard/connections?${qs}`)
  if (!p) return done('error=unknown_provider')
  const { code, state, error } = req.query
  if (error) return done(`error=${encodeURIComponent(String(error))}`)
  if (!code || !state) return done('error=missing_code')
  try {
    const { rows } = await pool.query(
      'DELETE FROM oauth_states WHERE state=$1 AND provider=$2 RETURNING user_id, created_at', [state, provider]
    )
    if (!rows[0]) return done('error=invalid_state')
    if (Date.now() - new Date(rows[0].created_at).getTime() > STATE_TTL_MS) return done('error=state_expired')
    const userId = rows[0].user_id

    const tokenData = await p.exchange(code)
    const identity = await p.identity(tokenData.access_token)
    await p.store({ userId, tokenData, identity })
    await logAudit({ userId, action: `${provider}.oauth_connect`, resourceType: `${provider}_account`, metadata: {} })
    return done(`connected=${provider}`)
  } catch (e) {
    console.error(`[oauth/${provider}/callback]`, e.message)
    return done('error=exchange_failed')
  }
})

export default r
