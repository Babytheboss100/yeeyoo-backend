// /api/threads — Threads Graph API (to-stegs: create container → publish).
// HOLO Sesjon J. Authed + tenant-isolert. Tokens kryptert ved insert, dekrypteres
// ved bruk.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { resolveAccount, listAccounts } from '../lib/socialAccounts.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

const BASE = 'https://graph.threads.net/v1.0'
const LIST_COLS = ['id', 'project_id', 'threads_user_id', 'username', 'display_name', 'active', 'created_at']

r.post('/accounts', async (req, res) => {
  const { projectId, threadsUserId, username, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!threadsUserId || !accessToken) return res.status(400).json({ error: 'threadsUserId og accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO threads_accounts (id, user_id, project_id, threads_user_id, username, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, threadsUserId, username || null, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('threads_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, text, imageUrl? }
r.post('/post', async (req, res) => {
  const { projectId, accountId, text, imageUrl } = req.body || {}
  if (!text && !imageUrl) return res.status(400).json({ error: 'text eller imageUrl kreves' })
  try {
    const account = await resolveAccount('threads_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv Threads-konto funnet' })
    const token = decryptToken(account.access_token)

    // 1) Opprett media-container
    const createParams = new URLSearchParams({
      media_type: imageUrl ? 'IMAGE' : 'TEXT',
      access_token: token,
    })
    if (text) createParams.set('text', text)
    if (imageUrl) createParams.set('image_url', imageUrl)
    const createRes = await fetch(`${BASE}/${account.threads_user_id}/threads?${createParams.toString()}`, { method: 'POST' })
    const createData = await createRes.json().catch(() => ({}))
    if (!createRes.ok || !createData.id) {
      return res.status(502).json({ error: createData?.error?.message || `Threads API ${createRes.status} (create)` })
    }

    // 2) Publiser
    const pubParams = new URLSearchParams({ creation_id: createData.id, access_token: token })
    const pubRes = await fetch(`${BASE}/${account.threads_user_id}/threads_publish?${pubParams.toString()}`, { method: 'POST' })
    const pubData = await pubRes.json().catch(() => ({}))
    if (!pubRes.ok || !pubData.id) {
      return res.status(502).json({ error: pubData?.error?.message || `Threads API ${pubRes.status} (publish)` })
    }

    await logAudit({
      userId: req.user.id, action: 'threads.post', resourceType: 'threads_account', resourceId: account.id,
      metadata: { threadId: pubData.id, hasImage: !!imageUrl },
    })
    res.json({ ok: true, platform: 'threads', threadId: pubData.id, displayName: account.display_name })
  } catch (e) {
    console.error('[threads/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
