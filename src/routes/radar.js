// /api/radar — Yeeyoo Radar (RSS + keyword-overvåkning). HOLO Sesjon J, #7.
// Authed + tenant-isolert. Items kan brukes av Tony som content-ideas.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { fetchAndParseFeed, keywordFeedUrl, ingestFeed, refreshAllActiveFeeds } from '../lib/radar.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

// POST /feeds — { projectId?, url?, keyword?, lang? }. url → RSS-feed, keyword →
// Google News RSS-søk. Henter items umiddelbart.
r.post('/feeds', async (req, res) => {
  const { projectId, url, keyword, lang } = req.body || {}
  if (!url && !keyword) return res.status(400).json({ error: 'url eller keyword kreves' })
  try {
    const type = keyword ? 'keyword' : 'rss'
    const feedUrl = keyword ? keywordFeedUrl(keyword, lang) : url
    let title = keyword ? `🔎 ${keyword}` : null
    if (!keyword) {
      try { title = (await fetchAndParseFeed(feedUrl)).feedTitle || url } catch { title = url }
    }
    const id = crypto.randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO radar_feeds (id, user_id, project_id, type, keyword, url, title)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, url) DO UPDATE SET active = TRUE
       RETURNING *`,
      [id, req.user.id, projectId || null, type, keyword || null, feedUrl, title]
    )
    const feed = rows[0]
    let added = 0
    try { added = await ingestFeed(feed) } catch (e) { console.warn('[radar] init ingest', e.message) }
    await logAudit({ userId: req.user.id, action: 'radar.feed_add', resourceType: 'radar_feed', resourceId: feed.id, metadata: { type, keyword: keyword || null } })
    res.json({ feed: { id: feed.id, type: feed.type, keyword: feed.keyword, url: feed.url, title: feed.title }, newItems: added })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/feeds', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.type, f.keyword, f.url, f.title, f.active, f.last_fetched_at, f.project_id,
              COALESCE(c.cnt,0)::int AS item_count
       FROM radar_feeds f
       LEFT JOIN (SELECT feed_id, COUNT(*) cnt FROM radar_items GROUP BY feed_id) c ON c.feed_id = f.id
       WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [req.user.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.delete('/feeds/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM radar_feeds WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
    if (!rowCount) return res.status(404).json({ error: 'Feed ikke funnet' })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /feeds/:id/refresh — hent nye items nå.
r.post('/feeds/:id/refresh', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM radar_feeds WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
    if (!rows[0]) return res.status(404).json({ error: 'Feed ikke funnet' })
    const added = await ingestFeed(rows[0])
    res.json({ ok: true, newItems: added })
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// GET /items — aggregerte treff (tenant-isolert). ?feedId ?projectId ?limit ?since
r.get('/items', async (req, res) => {
  try {
    const params = [req.user.id]
    let where = 'ri.user_id = $1'
    if (req.query.feedId) { params.push(req.query.feedId); where += ` AND ri.feed_id = $${params.length}` }
    if (req.query.projectId) { params.push(req.query.projectId); where += ` AND f.project_id = $${params.length}` }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
    params.push(limit)
    const { rows } = await pool.query(
      `SELECT ri.id, ri.title, ri.link, ri.summary, ri.published_at, ri.created_at,
              f.id AS feed_id, f.title AS feed_title, f.keyword
       FROM radar_items ri JOIN radar_feeds f ON f.id = ri.feed_id
       WHERE ${where}
       ORDER BY COALESCE(ri.published_at, ri.created_at) DESC
       LIMIT $${params.length}`, params
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /refresh-all — admin/scheduler-trigger: poll alle aktive feeds.
r.post('/refresh-all', async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Kun admin' })
  try {
    const total = await refreshAllActiveFeeds()
    res.json({ ok: true, newItems: total })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default r
