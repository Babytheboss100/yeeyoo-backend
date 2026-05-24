// /api/moodboard — Brand DNA 2.0 moodboard (HOLO Sesjon J).
// Én moodboard per prosjekt. Authed + tenant-isolert.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// GET /?projectId= — hent moodboard (tom array hvis ingen).
r.get('/', async (req, res) => {
  const projectId = req.query.projectId
  if (!projectId) return res.status(400).json({ error: 'projectId kreves' })
  try {
    const { rows } = await pool.query(
      'SELECT items, updated_at FROM moodboards WHERE project_id=$1 AND user_id=$2', [projectId, req.user.id]
    )
    res.json({ items: rows[0]?.items || [], updatedAt: rows[0]?.updated_at || null })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT / — { projectId, items[] }. Upsert.
r.put('/', async (req, res) => {
  const { projectId, items } = req.body || {}
  if (!projectId || !Array.isArray(items)) return res.status(400).json({ error: 'projectId og items[] kreves' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO moodboards (id, user_id, project_id, items, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (project_id) DO UPDATE SET items = EXCLUDED.items, updated_at = NOW()
       WHERE moodboards.user_id = $2
       RETURNING items, updated_at`,
      [crypto.randomUUID(), req.user.id, projectId, JSON.stringify(items)]
    )
    if (!rows[0]) return res.status(403).json({ error: 'Ikke ditt prosjekt' })
    res.json({ ok: true, items: rows[0].items, updatedAt: rows[0].updated_at })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default r
