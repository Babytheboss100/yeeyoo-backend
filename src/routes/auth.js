import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()

r.post('/register', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'Mangler felt' })
  try {
    const hash = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email',
      [name, email, hash]
    )
    const token = jwt.sign({ id: rows[0].id, email }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, user: rows[0] })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'E-post allerede i bruk' })
    res.status(500).json({ error: e.message })
  }
})

r.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
    if (!rows[0]) return res.status(401).json({ error: 'Feil e-post eller passord' })
    const ok = await bcrypt.compare(password, rows[0].password_hash)
    if (!ok) return res.status(401).json({ error: 'Feil e-post eller passord' })
    const token = jwt.sign({ id: rows[0].id, email }, process.env.JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// /me with auth middleware — fixed: was missing middleware before
r.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, created_at FROM users WHERE id=$1', [req.user.id])
    if (!rows[0]) return res.status(404).json({ error: 'Bruker ikke funnet' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
