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

app.get('/health', (_, res) => res.json({ status: 'ok', version: '6.0.0' }))

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Yeeyoo backend v6.0 kjører på port ${PORT}`))
}).catch(e => {
  console.error('DB init feilet:', e.message)
  process.exit(1)
})
