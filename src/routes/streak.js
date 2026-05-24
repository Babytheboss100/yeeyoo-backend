// /api/streak — streak gamification (HOLO Sesjon J).
// Streaken bumpes automatisk i logAudit() ved hver sosiale post.

import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { isStreakAlive } from '../lib/streak.js'

const r = Router()
r.use(auth)

// GET /me — innlogget brukers streak. Viser 0 hvis streaken er brutt (ikke
// postet i dag eller i går), uten å mutere lagret verdi.
r.get('/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT streak_count, last_post_at FROM users WHERE id=$1', [req.user.id]
    )
    const row = rows[0] || {}
    const alive = isStreakAlive(row.last_post_at)
    res.json({
      streak_count: alive ? (row.streak_count || 0) : 0,
      stored_count: row.streak_count || 0,
      last_post_at: row.last_post_at || null,
      alive,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
