// /api/tiktok — TikTok Content Posting API (kun video). HOLO Sesjon J.
//
// Direct Post via PULL_FROM_URL. Krever TikTok app review. Uautoriserte apper
// må bruke privacy_level SELF_ONLY (default her). Authed + tenant-isolert.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { resolveAccount, listAccounts } from '../lib/socialAccounts.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

const LIST_COLS = ['id', 'project_id', 'open_id', 'display_name', 'active', 'created_at']

r.post('/accounts', async (req, res) => {
  const { projectId, openId, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!accessToken) return res.status(400).json({ error: 'accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO tiktok_accounts (id, user_id, project_id, open_id, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, openId || null, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('tiktok_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, videoUrl, caption?, privacyLevel? }
// Kun video. videoUrl må være offentlig tilgjengelig (PULL_FROM_URL).
r.post('/post', async (req, res) => {
  const { projectId, accountId, videoUrl, caption, privacyLevel } = req.body || {}
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl kreves (TikTok støtter kun video)' })
  try {
    const account = await resolveAccount('tiktok_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv TikTok-konto funnet' })
    const token = decryptToken(account.access_token)

    const apiRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        post_info: {
          title: caption || '',
          privacy_level: privacyLevel || 'SELF_ONLY', // uautorisert app → privat
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
      }),
    })
    const data = await apiRes.json().catch(() => ({}))
    // TikTok returnerer error.code='ok' ved suksess; alt annet er feil.
    const errCode = data?.error?.code
    if (!apiRes.ok || (errCode && errCode !== 'ok')) {
      return res.status(502).json({ error: data?.error?.message || `TikTok API ${apiRes.status}` })
    }
    const publishId = data.data?.publish_id || null

    await logAudit({
      userId: req.user.id, action: 'tiktok.post', resourceType: 'tiktok_account', resourceId: account.id,
      metadata: { publishId, hasCaption: !!caption, privacyLevel: privacyLevel || 'SELF_ONLY' },
    })
    res.json({ ok: true, platform: 'tiktok', publishId, displayName: account.display_name })
  } catch (e) {
    console.error('[tiktok/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
