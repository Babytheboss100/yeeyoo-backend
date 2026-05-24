// /api/audit — metadata-only innsyn i revisjonssporet (HOLO Sesjon J).
//
// Vanlige brukere ser kun egne hendelser. Admin kan se på tvers (?all=1 eller
// ?userId=…), men alltid KUN metadata — aldri meldingsinnhold/tokens (de
// lagres uansett ikke i audit_log).

import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

r.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500)
    const params = []
    let where = '1=1'

    if (req.user.is_admin && (req.query.all === '1' || req.query.userId)) {
      if (req.query.userId) {
        params.push(req.query.userId)
        where = `user_id = $${params.length}`
      }
      // ?all=1 uten userId → ingen ekstra filter (alle brukere)
    } else {
      params.push(req.user.id)
      where = `user_id = $${params.length}`
    }

    if (req.query.action) {
      params.push(req.query.action)
      where += ` AND action = $${params.length}`
    }

    params.push(limit)
    const { rows } = await pool.query(
      `SELECT id, user_id, action, resource_type, resource_id, metadata, created_at
       FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
