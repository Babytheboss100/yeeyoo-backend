import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// GET /export/csv — download all posts as CSV
r.get('/csv', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.content, p.platform, p.ai_model, p.status, p.created_at, p.scheduled_at,
             pr.name as project_name
      FROM posts p
      LEFT JOIN projects pr ON p.project_id = pr.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.id])

    const headers = ['Prosjekt', 'Plattform', 'AI-modell', 'Status', 'Opprettet', 'Planlagt', 'Innhold']
    const csvRows = rows.map(r => [
      r.project_name || '-',
      r.platform,
      r.ai_model || '-',
      r.status,
      new Date(r.created_at).toLocaleString('no-NO'),
      r.scheduled_at ? new Date(r.scheduled_at).toLocaleString('no-NO') : '-',
      `"${r.content.replace(/"/g, '""').replace(/\n/g, ' ')}"`
    ])

    const csv = [headers.join(','), ...csvRows.map(r => r.join(','))].join('\n')

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="yeeyoo-innhold.csv"')
    res.send('\uFEFF' + csv)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /export/analytics — detailed analytics data
r.get('/analytics', async (req, res) => {
  try {
    const [
      byPlatform,
      byModel,
      byDay,
      byStatus,
      byProject
    ] = await Promise.all([
      pool.query(`
        SELECT platform, COUNT(*) as count FROM posts
        WHERE user_id=$1 GROUP BY platform ORDER BY count DESC
      `, [req.user.id]),
      pool.query(`
        SELECT COALESCE(ai_model, 'claude') as model, COUNT(*) as count FROM posts
        WHERE user_id=$1 GROUP BY ai_model ORDER BY count DESC
      `, [req.user.id]),
      pool.query(`
        SELECT DATE(created_at) as day, COUNT(*) as count FROM posts
        WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY day ASC
      `, [req.user.id]),
      pool.query(`
        SELECT status, COUNT(*) as count FROM posts
        WHERE user_id=$1 GROUP BY status
      `, [req.user.id]),
      pool.query(`
        SELECT pr.name, pr.color, COUNT(p.id) as count FROM posts p
        JOIN projects pr ON p.project_id = pr.id
        WHERE p.user_id=$1 GROUP BY pr.name, pr.color ORDER BY count DESC
      `, [req.user.id])
    ])

    res.json({
      byPlatform: byPlatform.rows,
      byModel: byModel.rows,
      byDay: byDay.rows,
      byStatus: byStatus.rows,
      byProject: byProject.rows
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
