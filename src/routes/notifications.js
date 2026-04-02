import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// GET /notifications — list user notifications
r.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /notifications/unread-count
r.get('/unread-count', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id=$1 AND read=false',
      [req.user.id]
    )
    res.json({ count: parseInt(rows[0].count) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /notifications/:id/read
r.patch('/:id/read', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /notifications/read-all
r.patch('/read-all', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read=true WHERE user_id=$1',
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r

// Helper: create notification (used by other routes)
export async function createNotification(userId, title, message, type = 'info', link = null) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1,$2,$3,$4,$5)',
      [userId, title, message, type, link]
    )
  } catch (e) {
    console.error('Notification error:', e.message)
  }
}
