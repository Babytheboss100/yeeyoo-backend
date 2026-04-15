import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
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
import affiliateRoutes from './routes/affiliate.js'
import { auth } from './middleware/auth.js'
import { corsOptions, generalLimiter, generateLimiter, aiLimiter, suspiciousActivityLogger } from './middleware/security.js'
import { trimStrings } from './middleware/sanitize.js'

const app = express()
const PORT = process.env.PORT || 3001

// ─── Security middleware ─────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}))
app.use(cors(corsOptions))
app.set('trust proxy', 1)

// Suspicious activity logging (before body parsing)
app.use(suspiciousActivityLogger)

// Webhook trenger raw body — må være FØR express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '1mb' }))
app.use(trimStrings)

// Rate limiting: 100 req / 15 min globally
app.use(generalLimiter)

// Stricter rate limit on content generation: 10 req / hour
app.use('/api/content/generate', generateLimiter)

// Rate limit on all AI endpoints: 20 req / hour
app.use('/api/images/generate', aiLimiter)
app.use('/api/seo/generate', aiLimiter)
app.use('/api/autopilot/generate', aiLimiter)
app.use('/api/smartplan/analyse', aiLimiter)

// ─── Admin middleware ────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.user.id])
  if (!rows[0]?.is_admin) return res.status(403).json({ error: 'Kun admin' })
  next()
}

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
app.use('/api/affiliate', affiliateRoutes)

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
app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, auth_provider, is_admin, email_verified, created_at FROM users ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Set admin flag
app.post('/api/admin/set-admin', auth, requireAdmin, async (req, res) => {
  try {
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

// ─── Admin: Waitlist ──────────────────────────────────────────────────────────
app.get('/api/admin/waitlist', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM invite_whitelist ORDER BY created_at DESC'
    )
    const { rows: total } = await pool.query(
      'SELECT COUNT(*) as count, COUNT(*) FILTER (WHERE approved=true) as approved, COUNT(*) FILTER (WHERE approved=false) as pending FROM invite_whitelist'
    )
    res.json({ entries: rows, stats: total[0] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Admin: Login logs ────────────────────────────────────────────────────────
app.get('/api/admin/logins', auth, requireAdmin, async (req, res) => {
  try {
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

app.get('/api/admin/login-stats', auth, requireAdmin, async (req, res) => {
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
