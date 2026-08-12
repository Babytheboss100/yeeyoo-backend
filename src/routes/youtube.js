// /api/youtube — YouTube Data API v3 video-opplasting. HOLO Sesjon J.
//
// Laster video fra videoUrl og laster opp via multipart. NB: multipart egner
// seg for moderate filer; store filer bør bruke resumable upload (TODO).
// Access tokens utløper ~1t — refresh_token lagres, men auto-refresh er TODO.
// Authed + tenant-isolert. Tokens kryptert ved insert, dekrypteres ved bruk.

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

const LIST_COLS = ['id', 'project_id', 'channel_id', 'channel_title', 'display_name', 'active', 'created_at']

r.post('/accounts', async (req, res) => {
  const { projectId, channelId, channelTitle, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!accessToken) return res.status(400).json({ error: 'accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO youtube_accounts (id, user_id, project_id, channel_id, channel_title, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, channelId || null, channelTitle || null, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('youtube_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, videoUrl, title, description?, tags?, privacy? }
r.post('/post', async (req, res) => {
  const { projectId, accountId, videoUrl, title, description, tags, privacy } = req.body || {}
  if (!videoUrl || !title) return res.status(400).json({ error: 'videoUrl og title kreves' })
  try {
    const account = await resolveAccount('youtube_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv YouTube-konto funnet' })
    const token = decryptToken(account.access_token)

    // Hent videoen
    const vidRes = await fetch(videoUrl)
    if (!vidRes.ok) return res.status(400).json({ error: `Kunne ikke hente videoUrl (${vidRes.status})` })
    const videoBuf = Buffer.from(await vidRes.arrayBuffer())

    // Bygg multipart/related body
    const boundary = 'yeeyoo' + crypto.randomBytes(8).toString('hex')
    const metadata = {
      snippet: {
        title,
        description: description || '',
        ...(Array.isArray(tags) ? { tags } : {}),
        categoryId: '22',
      },
      status: { privacyStatus: privacy || 'private', selfDeclaredMadeForKids: false },
    }
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: video/*\r\n\r\n`
    )
    const post = Buffer.from(`\r\n--${boundary}--`)
    const body = Buffer.concat([pre, videoBuf, post])

    const apiRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      }
    )
    const data = await apiRes.json().catch(() => ({}))
    if (!apiRes.ok) return res.status(502).json({ error: data?.error?.message || `YouTube API ${apiRes.status}` })
    const videoId = data.id || null

    await logAudit({
      userId: req.user.id, action: 'youtube.post', resourceType: 'youtube_account', resourceId: account.id,
      metadata: { videoId, privacy: privacy || 'private', bytes: videoBuf.length },
    })
    res.json({ ok: true, platform: 'youtube', videoId, url: videoId ? `https://youtu.be/${videoId}` : null, displayName: account.display_name })
  } catch (e) {
    console.error('[youtube/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
