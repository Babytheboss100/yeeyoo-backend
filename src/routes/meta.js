// /api/meta — Facebook Page + Instagram posting (HOLO Sesjon J).
//
// Alle ruter krever Bearer JWT og er tenant-isolert på req.user.id. Ingen
// auto-connect: meta_accounts-rader settes manuelt (whitelabel-identitet per kunde).

import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { resolveMetaAccount, postToFacebookPage, postToInstagram } from '../lib/meta.js'

const r = Router()
r.use(auth)

// GET /accounts — tenant-isolert liste (uten access_token).
r.get('/accounts', async (req, res) => {
  try {
    const params = [req.user.id]
    let where = 'user_id = $1'
    if (req.query.projectId) {
      params.push(req.query.projectId)
      where += ` AND project_id = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT id, project_id, page_id, page_name, ig_user_id, ig_username,
              display_name, active, created_at
       FROM meta_accounts WHERE ${where} ORDER BY created_at ASC`, params
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /facebook/post — { projectId?, accountId?, message?, link?, imageUrl? }
r.post('/facebook/post', async (req, res) => {
  const { projectId, accountId, message, link, imageUrl } = req.body || {}
  if (!message && !imageUrl) return res.status(400).json({ error: 'message eller imageUrl kreves' })
  try {
    const account = await resolveMetaAccount({ userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv Meta-konto funnet' })
    const result = await postToFacebookPage({ account, message, link, imageUrl })
    res.json({ ok: true, platform: 'facebook', postId: result.id, displayName: account.display_name || account.page_name })
  } catch (e) {
    console.error('[meta/facebook/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /instagram/post — { projectId?, accountId?, imageUrl, caption? }
r.post('/instagram/post', async (req, res) => {
  const { projectId, accountId, imageUrl, caption } = req.body || {}
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl kreves for Instagram' })
  try {
    const account = await resolveMetaAccount({ userId: req.user.id, projectId, accountId })
    if (!account || !account.active) return res.status(404).json({ error: 'Ingen aktiv Meta-konto funnet' })
    const result = await postToInstagram({ account, imageUrl, caption })
    res.json({ ok: true, platform: 'instagram', mediaId: result.id, displayName: account.display_name || account.ig_username })
  } catch (e) {
    console.error('[meta/instagram/post]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
