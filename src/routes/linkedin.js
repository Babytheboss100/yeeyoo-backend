// /api/linkedin — LinkedIn Share (UGC Posts API). HOLO Sesjon J.
//
// Krever LinkedIn app review for w_member_social. Alle ruter authed +
// tenant-isolert. Tokens krypteres ved insert, dekrypteres ved bruk.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { resolveAccount, listAccounts } from '../lib/socialAccounts.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

const LIST_COLS = ['id', 'project_id', 'author_urn', 'display_name', 'active', 'created_at']

// POST /accounts — registrer konto (token krypteres ved insert).
r.post('/accounts', async (req, res) => {
  const { projectId, authorUrn, displayName, accessToken, refreshToken, expiresAt } = req.body || {}
  if (!authorUrn || !accessToken) return res.status(400).json({ error: 'authorUrn og accessToken kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO linkedin_accounts (id, user_id, project_id, author_urn, display_name, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [crypto.randomUUID(), req.user.id, projectId || null, authorUrn, displayName || null,
       encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null, expiresAt || null]
    )
    res.json({ id: rows[0].id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/accounts', async (req, res) => {
  try {
    res.json(await listAccounts('linkedin_accounts', LIST_COLS, { userId: req.user.id, projectId: req.query.projectId }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /post — { projectId?, accountId?, text, link? }
r.post('/post', async (req, res) => {
  const { projectId, accountId, text, link } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text kreves' })
  try {
    const account = await resolveAccount('linkedin_accounts', { userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv LinkedIn-konto funnet' })
    const token = decryptToken(account.access_token)

    const body = {
      author: account.author_urn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: link ? 'ARTICLE' : 'NONE',
          ...(link ? { media: [{ status: 'READY', originalUrl: link }] } : {}),
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }
    const apiRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const data = await apiRes.json().catch(() => ({}))
    if (!apiRes.ok) return res.status(502).json({ error: data?.message || `LinkedIn API ${apiRes.status}` })
    const postId = data.id || apiRes.headers.get('x-restli-id') || null

    await logAudit({
      userId: req.user.id, action: 'linkedin.post', resourceType: 'linkedin_account', resourceId: account.id,
      metadata: { postId, hasLink: !!link },
    })
    res.json({ ok: true, platform: 'linkedin', postId, displayName: account.display_name })
  } catch (e) {
    console.error('[linkedin/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
