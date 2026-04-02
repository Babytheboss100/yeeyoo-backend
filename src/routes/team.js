import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// GET /team/:projectId — list team members
r.get('/:projectId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.*, u.name as user_name FROM team_members tm
       LEFT JOIN users u ON tm.user_id = u.id
       WHERE tm.project_id = $1 AND (tm.invited_by = $2 OR tm.user_id = $2)`,
      [req.params.projectId, req.user.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /team/invite — invite member
r.post('/invite', async (req, res) => {
  const { projectId, email, role } = req.body
  if (!projectId || !email) return res.status(400).json({ error: 'Mangler prosjekt eller e-post' })

  const validRoles = ['admin', 'editor', 'viewer']
  const memberRole = validRoles.includes(role) ? role : 'editor'

  try {
    // Verify user owns the project
    const { rows: proj } = await pool.query(
      'SELECT * FROM projects WHERE id=$1 AND user_id=$2', [projectId, req.user.id]
    )
    if (!proj[0]) return res.status(403).json({ error: 'Ikke ditt prosjekt' })

    const inviteToken = crypto.randomBytes(20).toString('hex')

    // Check if invited user already exists
    const { rows: existingUser } = await pool.query('SELECT id FROM users WHERE email=$1', [email])

    const { rows } = await pool.query(
      `INSERT INTO team_members (project_id, user_id, invited_by, email, role, status, invite_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, email) DO UPDATE SET role=$5, invite_token=$7
       RETURNING *`,
      [projectId, existingUser[0]?.id || null, req.user.id, email, memberRole,
       existingUser[0] ? 'active' : 'pending', inviteToken]
    )

    // Create notification for invited user if they exist
    if (existingUser[0]) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, link)
         VALUES ($1, $2, $3, 'team', $4)`,
        [existingUser[0].id, 'Teaminnbydelse',
         `${req.user.email} inviterte deg til prosjektet "${proj[0].name}"`,
         `/app?tab=settings`]
      )
    }

    res.json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Allerede invitert' })
    res.status(500).json({ error: e.message })
  }
})

// DELETE /team/:id — remove member
r.delete('/:id', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM team_members WHERE id=$1 AND invited_by=$2`,
      [req.params.id, req.user.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /team/:id/role — change role
r.patch('/:id/role', async (req, res) => {
  const { role } = req.body
  const validRoles = ['admin', 'editor', 'viewer']
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Ugyldig rolle' })

  try {
    const { rows } = await pool.query(
      `UPDATE team_members SET role=$1 WHERE id=$2 AND invited_by=$3 RETURNING *`,
      [role, req.params.id, req.user.id]
    )
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
