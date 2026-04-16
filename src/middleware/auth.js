import jwt from 'jsonwebtoken'
import { pool } from '../db.js'

export async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Ikke autentisert', redirect: '/login' })
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const { rows } = await pool.query(
      'SELECT id, name, email, is_admin FROM users WHERE id=$1', [decoded.id]
    )
    if (!rows[0]) return res.status(401).json({ error: 'Bruker finnes ikke lenger', redirect: '/login' })
    req.user = rows[0]
    next()
  } catch (e) {
    if (e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Økten har utløpt — logg inn på nytt', redirect: '/login' })
    res.status(401).json({ error: 'Ugyldig token', redirect: '/login' })
  }
}
