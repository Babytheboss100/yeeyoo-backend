// /api/x — X (Twitter) API v2 posting. HOLO Sesjon J.
//
// Krever X API Basic/Pro tier for å poste. Alle ruter authed + tenant-isolert.
// Tokens krypteres ved insert, dekrypteres ved bruk.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { resolveAccount, listAccounts } from '../lib/socialAccounts.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

const LIST_COLS = ['id', 'project_id', 'x_user_id', 'username', 'display_name', 'active', 'created_at']

r.post('/accounts', async (req, res) => {
  const { projectId, xUserId, username, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!accessToken) return res.status(400).json({ error: 'accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO x_accounts (id, user_id, project_id, x_user_id, username, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, xUserId || null, username || null, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('x_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, text }
r.post('/post', async (req, res) => {
  const { projectId, accountId, text } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text kreves' })
  if (text.length > 280) return res.status(400).json({ error: 'text overskrider 280 tegn' })
  try {
    const account = await resolveAccount('x_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv X-konto funnet' })
    const token = decryptToken(account.access_token)

    const apiRes = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    })
    const data = await apiRes.json().catch(() => ({}))
    if (!apiRes.ok) return res.status(502).json({ error: data?.detail || data?.title || `X API ${apiRes.status}` })
    const tweetId = data.data?.id || null

    await logAudit({
      userId: req.user.id, action: 'x.post', resourceType: 'x_account', resourceId: account.id,
      metadata: { tweetId, length: text.length },
    })
    res.json({ ok: true, platform: 'x', tweetId, displayName: account.display_name || account.username })
  } catch (e) {
    console.error('[x/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
