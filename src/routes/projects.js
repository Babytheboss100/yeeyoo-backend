import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// GET all projects for user
r.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at ASC',
    [req.user.id]
  )
  res.json(rows)
})

// POST create project
r.post('/', async (req, res) => {
  const { name, slug, color, tone, audience, keywords, about } = req.body
  try {
    console.log('POST /api/projects — user_id:', req.user.id, 'name:', name)
    const { rows } = await pool.query(
      `INSERT INTO projects (id, user_id, name, slug, color, tone, audience, keywords, about)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, name, slug || name.toLowerCase().replace(/\s+/g,'-'), color||'#5555ff', tone||'profesjonell', audience||'investorer', keywords||'', about||'']
    )
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT update project
r.put('/:id', async (req, res) => {
  const { name, color, tone, audience, keywords, about } = req.body
  const { rows } = await pool.query(
    `UPDATE projects SET name=$1, color=$2, tone=$3, audience=$4, keywords=$5, about=$6
     WHERE id=$7 AND user_id=$8 RETURNING *`,
    [name, color, tone, audience, keywords, about, req.params.id, req.user.id]
  )
  res.json(rows[0])
})

// DELETE project
r.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
  res.json({ ok: true })
})

export default r
