// /api/reddit — Reddit submit API (self/link). HOLO Sesjon J.
//
// Reddit krever beskrivende User-Agent (REDDIT_USER_AGENT). Authed +
// tenant-isolert. Tokens kryptert ved insert, dekrypteres ved bruk.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { resolveAccount, listAccounts } from '../lib/socialAccounts.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

const USER_AGENT = process.env.REDDIT_USER_AGENT || 'yeeyoo-saas/1.0'
const LIST_COLS = ['id', 'project_id', 'reddit_username', 'display_name', 'active', 'created_at']

r.post('/accounts', async (req, res) => {
  const { projectId, redditUsername, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!accessToken) return res.status(400).json({ error: 'accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO reddit_accounts (id, user_id, project_id, reddit_username, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, redditUsername || null, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('reddit_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, subreddit, title, text?, url? }
// text → self-post, url → link-post.
r.post('/post', async (req, res) => {
  const { projectId, accountId, subreddit, title, text, url } = req.body || {}
  if (!subreddit || !title) return res.status(400).json({ error: 'subreddit og title kreves' })
  if (!text && !url) return res.status(400).json({ error: 'text (self) eller url (link) kreves' })
  try {
    const account = await resolveAccount('reddit_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv Reddit-konto funnet' })
    const token = decryptToken(account.access_token)

    const form = new URLSearchParams({
      sr: subreddit,
      title,
      kind: url ? 'link' : 'self',
      api_type: 'json',
    })
    if (url) form.set('url', url)
    else form.set('text', text)

    const apiRes = await fetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: form.toString(),
    })
    const data = await apiRes.json().catch(() => ({}))
    const errors = data?.json?.errors
    if (!apiRes.ok || (Array.isArray(errors) && errors.length)) {
      return res.status(502).json({ error: errors?.[0]?.join(': ') || `Reddit API ${apiRes.status}` })
    }
    const postUrl = data?.json?.data?.url || null
    const postId = data?.json?.data?.name || null

    await logAudit({
      userId: req.user.id, action: 'reddit.post', resourceType: 'reddit_account', resourceId: account.id,
      metadata: { subreddit, kind: url ? 'link' : 'self', postId },
    })
    res.json({ ok: true, platform: 'reddit', postId, url: postUrl, displayName: account.display_name })
  } catch (e) {
    console.error('[reddit/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
