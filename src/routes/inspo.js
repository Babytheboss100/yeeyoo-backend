// /api/inspo — Inspo-bibliotek (HOLO Sesjon J, #6).
//
// Nisjer er globale (delt katalog). Lagrede items er per-bruker (tenant-isolert).
// Alle ruter krever auth. POST /items er admin-only.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

// GET /niches — alle aktive nisjer med item-count.
r.get('/niches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*, COALESCE(c.cnt, 0)::int AS item_count
       FROM inspo_niches n
       LEFT JOIN (SELECT niche_id, COUNT(*) AS cnt FROM inspo_items GROUP BY niche_id) c ON c.niche_id = n.id
       WHERE n.active = TRUE
       ORDER BY n.name_en ASC`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /niches/:slug — full info for én nisje.
r.get('/niches/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inspo_niches WHERE slug=$1', [req.params.slug])
    if (!rows[0]) return res.status(404).json({ error: 'Nisje ikke funnet' })
    res.json(rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /niches/:slug/items — paginert. ?limit ?offset ?language
r.get('/niches/:slug/items', async (req, res) => {
  try {
    const { rows: nrows } = await pool.query('SELECT id FROM inspo_niches WHERE slug=$1', [req.params.slug])
    if (!nrows[0]) return res.status(404).json({ error: 'Nisje ikke funnet' })
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100)
    const offset = parseInt(req.query.offset, 10) || 0
    const params = [nrows[0].id]
    let where = 'niche_id = $1'
    if (req.query.language) { params.push(req.query.language); where += ` AND language = $${params.length}` }
    params.push(limit, offset)
    const { rows } = await pool.query(
      `SELECT id, title, description, image_url, source_url, platform, engagement_score, language, created_at
       FROM inspo_items WHERE ${where}
       ORDER BY engagement_score DESC NULLS LAST, created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /save — { inspoItemId, notes? }
r.post('/save', async (req, res) => {
  const { inspoItemId, notes } = req.body || {}
  if (!inspoItemId) return res.status(400).json({ error: 'inspoItemId kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO user_saved_inspo (id, user_id, inspo_item_id, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, inspo_item_id) DO UPDATE SET notes = EXCLUDED.notes
       RETURNING id, saved_at`,
      [crypto.randomUUID(), req.user.id, inspoItemId, notes || null]
    )
    res.json({ ok: true, id: rows[0].id, savedAt: rows[0].saved_at })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /saved — brukerens lagrede inspo (tenant-isolert).
r.get('/saved', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id AS saved_id, s.notes, s.saved_at,
              i.id, i.title, i.description, i.image_url, i.source_url, i.platform, i.language,
              n.slug AS niche_slug
       FROM user_saved_inspo s
       JOIN inspo_items i ON i.id = s.inspo_item_id
       LEFT JOIN inspo_niches n ON n.id = i.niche_id
       WHERE s.user_id = $1 ORDER BY s.saved_at DESC LIMIT 200`, [req.user.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /items — admin-only: legg til ny inspo.
r.post('/items', async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Kun admin' })
  const { nicheSlug, nicheId, title, description, imageUrl, sourceUrl, platform, engagementScore, language } = req.body || {}
  try {
    let nid = nicheId
    if (!nid && nicheSlug) {
      const { rows } = await pool.query('SELECT id FROM inspo_niches WHERE slug=$1', [nicheSlug])
      nid = rows[0]?.id
    }
    if (!nid) return res.status(400).json({ error: 'nicheId eller gyldig nicheSlug kreves' })
    const id = crypto.randomUUID()
    await pool.query(
      `INSERT INTO inspo_items (id, niche_id, title, description, image_url, source_url, platform, engagement_score, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, nid, title || null, description || null, imageUrl || null, sourceUrl || null, platform || null,
       Number.isInteger(engagementScore) ? engagementScore : null, language || 'en']
    )
    await logAudit({ userId: req.user.id, action: 'inspo.item_create', resourceType: 'inspo_item', resourceId: id, metadata: { nicheId: nid, platform: platform || null } })
    res.json({ ok: true, id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default r
