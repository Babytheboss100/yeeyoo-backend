import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
dotenv.config()

import { initDB, pool } from './db.js'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import contentRoutes from './routes/content.js'
import billingRoutes from './routes/billing.js'
import teamRoutes from './routes/team.js'
import notificationRoutes from './routes/notifications.js'
import exportRoutes from './routes/export.js'
import seoRoutes from './routes/seo.js'
import smartplanRoutes from './routes/smartplan.js'
import autopilotRoutes from './routes/autopilot.js'
import imageRoutes from './routes/images.js'
import campaignRoutes from './routes/campaigns.js'
import { auth } from './middleware/auth.js'

const app = express()
const PORT = process.env.PORT || 3001

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors({ origin: true, credentials: true }))
app.set('trust proxy', 1)

// Webhook trenger raw body — må være FØR express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }))

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/content', contentRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/team', teamRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/export', exportRoutes)
app.use('/api/seo', seoRoutes)
app.use('/api/smartplan', smartplanRoutes)
app.use('/api/autopilot', autopilotRoutes)
app.use('/api/images', imageRoutes)
app.use('/api/campaigns', campaignRoutes)

// ─── Onboarding ───────────────────────────────────────────────────────────────
app.get('/api/onboarding/status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT onboarding_done FROM users WHERE id=$1', [req.user.id])
    const { rows: projCount } = await pool.query('SELECT COUNT(*) as count FROM projects WHERE user_id=$1', [req.user.id])
    const { rows: postCount } = await pool.query('SELECT COUNT(*) as count FROM posts WHERE user_id=$1', [req.user.id])
    res.json({
      done: rows[0]?.onboarding_done || false,
      hasProject: parseInt(projCount[0].count) > 0,
      hasPost: parseInt(postCount[0].count) > 0
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/onboarding/complete', auth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET onboarding_done=true WHERE id=$1', [req.user.id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Admin: Users ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, auth_provider, is_admin, email_verified, created_at FROM users ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Set admin flag (only first user / existing admin can do this)
app.post('/api/admin/set-admin', auth, async (req, res) => {
  try {
    // Check caller is admin or first user
    const { rows: caller } = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.user.id])
    const { rows: first } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1')
    if (!caller[0]?.is_admin && req.user.id !== first[0]?.id) {
      return res.status(403).json({ error: 'Kun admin' })
    }

    const { email, isAdmin } = req.body
    if (!email) return res.status(400).json({ error: 'E-post mangler' })

    const { rows } = await pool.query(
      'UPDATE users SET is_admin=$1 WHERE LOWER(email)=LOWER($2) RETURNING id, email, is_admin',
      [isAdmin !== false, email]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Bruker ikke funnet' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Admin: Login logs ────────────────────────────────────────────────────────
app.get('/api/admin/logins', auth, async (req, res) => {
  try {
    // Check admin
    const { rows: u } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    // Allow first user or admin role
    const { rows: firstUser } = await pool.query('SELECT id FROM users ORDER BY created_at LIMIT 1')
    if (u[0]?.id !== firstUser[0]?.id) return res.status(403).json({ error: 'Admin only' })

    const { limit = 100, offset = 0 } = req.query
    const { rows } = await pool.query(
      'SELECT * FROM login_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [parseInt(limit), parseInt(offset)]
    )
    const { rows: total } = await pool.query('SELECT COUNT(*) as count FROM login_logs')
    res.json({ logins: rows, total: parseInt(total[0].count) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/admin/login-stats', auth, async (req, res) => {
  try {
    const [byMethod, byCountry, byDay, recent] = await Promise.all([
      pool.query('SELECT method, COUNT(*) as count FROM login_logs GROUP BY method ORDER BY count DESC'),
      pool.query('SELECT country, COUNT(*) as count FROM login_logs WHERE country IS NOT NULL GROUP BY country ORDER BY count DESC LIMIT 20'),
      pool.query(`SELECT DATE(created_at) as day, COUNT(*) as count FROM login_logs
        WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day`),
      pool.query('SELECT * FROM login_logs ORDER BY created_at DESC LIMIT 10'),
    ])
    res.json({
      byMethod: byMethod.rows,
      byCountry: byCountry.rows,
      byDay: byDay.rows,
      recent: recent.rows,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/health', (_, res) => res.json({ status: 'ok', version: '7.0.0' }))

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    console.log('Starting DB init...')
    await initDB()
    console.log('DB init complete, starting server...')
    app.listen(PORT, () => console.log(`🚀 Yeeyoo backend v6.0 kjører på port ${PORT}`))
  } catch (e) {
    console.error('=== STARTUP CRASH ===')
    console.error('Error:', e.message)
    console.error('Stack:', e.stack)
    console.error('Full error:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2))
    process.exit(1)
  }
}
start()

// Catch unhandled errors at module level
process.on('uncaughtException', (e) => {
  console.error('=== UNCAUGHT EXCEPTION ===')
  console.error(e.stack || e)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('=== UNHANDLED REJECTION ===')
  console.error(e?.stack || e)
  process.exit(1)
})
