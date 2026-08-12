// /api/pinterest — Pinterest API v5 (Pins). HOLO Sesjon J.
//
// Authed + tenant-isolert. Tokens krypteres ved insert, dekrypteres ved bruk.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { accountNeedsReconnect, resolveAccount, listAccounts } from '../lib/socialAccounts.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

const LIST_COLS = ['id', 'project_id', 'pinterest_user_id', 'default_board_id', 'display_name', 'active', 'created_at']

r.post('/accounts', async (req, res) => {
  const { projectId, pinterestUserId, defaultBoardId, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!accessToken) return res.status(400).json({ error: 'accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO pinterest_accounts (id, user_id, project_id, pinterest_user_id, default_board_id, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, pinterestUserId || null, defaultBoardId || null, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('pinterest_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, imageUrl, title?, description?, link?, boardId? }
r.post('/post', async (req, res) => {
  const { projectId, accountId, imageUrl, title, description, link, boardId } = req.body || {}
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl kreves' })
  try {
    const account = await resolveAccount('pinterest_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv Pinterest-konto funnet' })
    if (accountNeedsReconnect(account)) return res.status(409).json({ error: 'Pinterest-kontoen må kobles til på nytt', code: 'ACCOUNT_RECONNECT_REQUIRED' })
    const board = boardId || account.default_board_id
    if (!board) return res.status(400).json({ error: 'boardId kreves (eller sett default_board_id på kontoen)' })
    const token = decryptToken(account.access_token)

    const apiRes = await fetch('https://api.pinterest.com/v5/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        board_id: board,
        title: title || undefined,
        description: description || undefined,
        link: link || undefined,
        media_source: { source_type: 'image_url', url: imageUrl },
      }),
    })
    const data = await apiRes.json().catch(() => ({}))
    if (!apiRes.ok) return res.status(502).json({ error: data?.message || `Pinterest API ${apiRes.status}` })
    const pinId = data.id || null

    await logAudit({
      userId: req.user.id, action: 'pinterest.post', resourceType: 'pinterest_account', resourceId: account.id,
      metadata: { pinId, boardId: board, hasLink: !!link },
    })
    res.json({ ok: true, platform: 'pinterest', pinId, displayName: account.display_name })
  } catch (e) {
    console.error('[pinterest/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
