import rateLimit from 'express-rate-limit'

// ─── CORS whitelist ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://yeeyoo.no',
  'https://app.yeeyoo.no'
]

// Allow localhost in development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000')
}

export const corsOptions = {
  origin(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true)
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    callback(new Error(`CORS-blokkert: ${origin} er ikke tillatt`))
  },
  credentials: true
}

// ─── General rate limiter: 100 req / 15 min per IP ──────────────────────────
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange forespørsler. Prøv igjen om litt.' }
})

// ─── Strict rate limiter for /api/content/generate: 10 req / hour per IP ────
export const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Genererings-grensen er nådd (10/time). Prøv igjen senere.' }
})

// ─── AI endpoint limiter: 20 req / hour per IP (images, seo, autopilot, smartplan) ─
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI-grensen er nådd (20/time). Prøv igjen senere.' }
})

// ─── Suspicious activity logger ─────────────────────────────────────────────
const suspiciousPatterns = [
  /(\.\.\/)/, /(<script)/i, /(union\s+select)/i, /(\bor\b\s+1\s*=\s*1)/i,
  /(;\s*drop\s)/i, /(--\s*$)/m, /(\bexec\s*\()/i, /(\/etc\/passwd)/,
  /(\beval\s*\()/i, /(document\.cookie)/i
]

export function suspiciousActivityLogger(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress
  const url = req.originalUrl
  const body = JSON.stringify(req.body || {})
  const ua = req.get('user-agent') || ''

  const suspicious = []

  // Check URL and body for attack patterns
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(url)) suspicious.push(`url matched ${pattern}`)
    if (pattern.test(body)) suspicious.push(`body matched ${pattern}`)
  }

  // Flag missing or bot-like user agents
  if (!ua || ua.length < 10) suspicious.push('missing/short user-agent')

  // Flag attempts to access common attack paths
  const attackPaths = ['/wp-admin', '/wp-login', '/.env', '/phpinfo', '/phpmyadmin', '/admin/config', '/.git']
  if (attackPaths.some(p => url.toLowerCase().includes(p))) {
    suspicious.push(`attack path probe: ${url}`)
  }

  if (suspicious.length) {
    console.warn(`[SECURITY] Suspicious request from ${ip} — ${req.method} ${url} — ${suspicious.join('; ')} — UA: ${ua}`)
  }

  next()
}
