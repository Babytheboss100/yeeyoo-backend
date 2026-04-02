import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
dotenv.config()

import { initDB } from './db.js'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import contentRoutes from './routes/content.js'
import billingRoutes from './routes/billing.js'
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

// /api/auth/me is now handled in routes/auth.js with proper middleware

app.get('/health', (_, res) => res.json({ status: 'ok', version: '5.1.0' }))

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 GeirX backend kjører på port ${PORT}`))
}).catch(e => {
  console.error('DB init feilet:', e.message)
  process.exit(1)
})
