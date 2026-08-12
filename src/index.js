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
import campaignRoutes from './routes/campaigns.js'
import tonyRoutes from './routes/tony.js'
import tonyPlanRoutes from './routes/tony-plans.js'
import brandDnaRoutes from './routes/brand-dna.js'
import whatsappRoutes from './routes/whatsapp.js'
import metaRoutes from './routes/meta.js'
import auditRoutes from './routes/audit.js'
import linkedinRoutes from './routes/linkedin.js'
import xRoutes from './routes/x.js'
import tiktokRoutes from './routes/tiktok.js'
import pinterestRoutes from './routes/pinterest.js'
import threadsRoutes from './routes/threads.js'
import youtubeRoutes from './routes/youtube.js'
import redditRoutes from './routes/reddit.js'
import streakRoutes from './routes/streak.js'
import videoRoutes from './routes/video.js'
import inspoRoutes from './routes/inspo.js'
import radarRoutes from './routes/radar.js'
import { refreshAllActiveFeeds } from './lib/radar.js'
import inboxRoutes from './routes/inbox.js'
import integrationsRoutes from './routes/integrations.js'
import photoshootRoutes from './routes/photoshoot.js'
import translateImageRoutes from './routes/translateImage.js'
import moodboardRoutes from './routes/moodboard.js'
import oauthRoutes from './routes/oauth.js'
import marketingProfileRoutes from './routes/marketing-profile.js'
import marketingAuditRoutes from './routes/marketing-audit.js'
import marketingArtifactRoutes from './routes/marketing-artifacts.js'
import competitorRoutes from './routes/competitors.js'
import marketingSpecialistRoutes from './routes/marketing-specialists.js'
import channelOAuthRoutes from './routes/channel-oauth.js'
import approvalRoutes from './routes/approvals.js'
import activityRoutes from './routes/activity.js'
import reportingRoutes from './routes/reporting.js'
import jobRoutes from './routes/jobs.js'
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
// WhatsApp (Meta) webhook trenger rå body for X-Hub-Signature-256-verifisering
app.use('/api/whatsapp/webhook', express.raw({ type: 'application/json' }))
// Inbox (IG/FB DM) webhook — samme rå-body-krav for signaturverifisering
app.use('/api/inbox/webhook', express.raw({ type: 'application/json' }))
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
app.use('/api/tony/chat', aiLimiter)
app.use('/api/brand-dna/analyze', aiLimiter)

// ─── Admin middleware ────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.user.id])
  if (!rows[0]?.is_admin) return res.status(403).json({ error: 'Kun admin' })
  next()
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/marketing-profile', marketingProfileRoutes)
app.use('/api/marketing-audit', marketingAuditRoutes)
app.use('/api/marketing-artifacts', marketingArtifactRoutes)
app.use('/api/competitors', competitorRoutes)
app.use('/api/marketing-specialists', marketingSpecialistRoutes)
app.use('/api/channel-oauth', channelOAuthRoutes)
app.use('/api/approvals', approvalRoutes)
app.use('/api/activity', activityRoutes)
app.use('/api/reporting', reportingRoutes)
app.use('/api/jobs', jobRoutes)
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
app.use('/api/campaigns', campaignRoutes)
app.use('/api/tony', tonyRoutes)
app.use('/api/tony-plans', tonyPlanRoutes)
app.use('/api/brand-dna', brandDnaRoutes)
app.use('/api/whatsapp', whatsappRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/audit', auditRoutes)
app.use('/api/linkedin', linkedinRoutes)
app.use('/api/x', xRoutes)
app.use('/api/tiktok', tiktokRoutes)
app.use('/api/pinterest', pinterestRoutes)
app.use('/api/threads', threadsRoutes)
app.use('/api/youtube', youtubeRoutes)
app.use('/api/reddit', redditRoutes)
app.use('/api/streak', streakRoutes)
app.use('/api/video', videoRoutes)
app.use('/api/inspo', inspoRoutes)
app.use('/api/radar', radarRoutes)
app.use('/api/inbox', inboxRoutes)
app.use('/api/integrations', integrationsRoutes)
app.use('/api/photoshoot', photoshootRoutes)
app.use('/api/translate-image', translateImageRoutes)
app.use('/api/moodboard', moodboardRoutes)
app.use('/api/oauth', oauthRoutes)

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

// ─── Admin: Invite codes ─────────────────────────────────────────────────────
app.get('/api/admin/invite-codes', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM invite_codes ORDER BY code')
    const used = rows.filter(r => r.used).length
    res.json({ codes: rows, total: rows.length, used, available: rows.length - used })
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

    // Radar: daglig polling av aktive feeds (RSS + keyword). Første kjøring etter
    // 1 min, deretter hver 24t. Feiler mykt — tar aldri ned serveren.
    const DAY_MS = 24 * 60 * 60 * 1000
    setTimeout(() => {
      refreshAllActiveFeeds().catch((e) => console.error('[radar] poll-feil:', e.message))
      setInterval(() => {
        refreshAllActiveFeeds().catch((e) => console.error('[radar] poll-feil:', e.message))
      }, DAY_MS)
    }, 60 * 1000)
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
