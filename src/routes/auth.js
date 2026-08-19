import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { sendEmail, sendVerificationEmail } from '../services/email.js'
import { validateRegister, validateLogin } from '../middleware/sanitize.js'
import { requireAdmin } from '../middleware/admin.js'
import { requireTrustedOrigin } from '../middleware/security.js'
import {
  ACCESS_COOKIE, REFRESH_COOKIE, clearSessionCookies, consumeExchangeCode,
  createExchangeCode, createSession, parseCookies, revokeSession, rotateSession,
  setSessionCookies,
} from '../lib/session.js'
import { consumeLoginOauthState, createLoginOauthState } from '../lib/loginOauthState.js'
import { sendSafeError } from '../lib/safeError.js'

const r = Router()

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'heljarprebensen@gmail.com'

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Log login to database
async function logLogin(user, req, method = 'email') {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'
    const ua = req.headers['user-agent'] || 'unknown'

    // Get country from IP using free API (non-blocking)
    let country = null
    try {
      const geo = await fetch(`https://ipapi.co/${ip}/country_name/`, { signal: AbortSignal.timeout(3000) })
      if (geo.ok) country = await geo.text()
      if (country?.includes('<')) country = null // HTML error page
    } catch {}

    // Generer id eksplisitt: Prisma eier login_logs.id (TEXT NOT NULL uten
    // DB-default — Prisma genererer UUID i JS). Raw INSERT må gjøre det samme.
    await pool.query(
      'INSERT INTO login_logs (id, user_id, email, ip_address, user_agent, country, method) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [crypto.randomUUID(), user.id, user.email, ip, ua.substring(0, 500), country, method]
    )
  } catch (e) {
    console.error('Login log failed:', e.message)
  }
}

// Invite-only mode: check if email is whitelisted
const INVITE_ONLY = process.env.INVITE_ONLY !== 'false' // default ON
async function checkWhitelist(email) {
  if (!INVITE_ONLY) return true
  // Admins always bypass
  const { rows: user } = await pool.query(
    'SELECT is_admin FROM users WHERE LOWER(email)=LOWER($1)', [email]
  )
  if (user[0]?.is_admin === true) return true
  // Admin email always bypasses whitelist
  if (ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) return true
  // Check whitelist
  const { rows } = await pool.query(
    'SELECT approved FROM invite_whitelist WHERE LOWER(email)=LOWER($1)', [email]
  )
  return rows[0]?.approved === true
}

// Helper: find or create user from OAuth provider
async function findOrCreateOAuthUser({ sub, email, name, provider }) {
  // Check whitelist for new OAuth users (existing users bypass if admin)
  const { rows: existing } = await pool.query('SELECT id, is_admin FROM users WHERE email=$1', [email])
  if (existing[0]) {
    // Existing user — always allow (they're already in the system)
  } else if (!await checkWhitelist(email)) {
    throw new Error('invite_only')
  }

  // 1. Check by provider sub
  const { rows: bySub } = await pool.query(
    `SELECT * FROM users WHERE ${provider === 'vipps' ? 'vipps_sub' : 'google_sub'}=$1`, [sub]
  )
  if (bySub[0]) return bySub[0]

  // 2. Check by email (link accounts)
  const { rows: byEmail } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
  if (byEmail[0]) {
    const col = provider === 'vipps' ? 'vipps_sub' : 'google_sub'
    await pool.query(`UPDATE users SET ${col}=$1, auth_provider=$2 WHERE id=$3`, [sub, provider, byEmail[0].id])
    return byEmail[0]
  }

  // 3. Create new
  const col = provider === 'vipps' ? 'vipps_sub' : 'google_sub'
  const { rows } = await pool.query(
    `INSERT INTO users (id, name, email, ${col}, auth_provider, email_verified) VALUES (gen_random_uuid(),$1,$2,$3,$4,true) RETURNING *`,
    [name, email, sub, provider]
  )
  return rows[0]
}

// ─── INVITE CODE VERIFICATION ─────────────────────────────────────────────────

r.post('/verify-invite', async (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'Kode mangler' })
  try {
    const { rows } = await pool.query(
      'SELECT * FROM invite_codes WHERE UPPER(code) = UPPER($1)', [code.trim()]
    )
    if (!rows.length) return res.status(404).json({ error: 'Ugyldig invitasjonskode' })
    if (rows[0].used) return res.status(400).json({ error: 'Koden er allerede brukt' })
    res.json({ valid: true, code: rows[0].code })
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

// ─── EMAIL/PASSWORD ───────────────────────────────────────────────────────────

r.post('/register', validateRegister, async (req, res) => {
  const { name, email, password, phone, address, inviteCode, returnTo } = req.body
  if (!name || !email || !password || !phone) return res.status(400).json({ error: 'Mangler felt' })
  try {
    // If invite code provided, validate and skip whitelist
    let codeUsed = false
    if (inviteCode) {
      const { rows: codeRows } = await pool.query(
        'SELECT * FROM invite_codes WHERE UPPER(code) = UPPER($1)', [inviteCode.trim()]
      )
      if (!codeRows.length) return res.status(400).json({ error: 'Ugyldig invitasjonskode' })
      if (codeRows[0].used) return res.status(400).json({ error: 'Invitasjonskoden er allerede brukt' })
      codeUsed = true
    } else if (!await checkWhitelist(email)) {
      return res.status(403).json({ error: 'invite_only', message: 'Vi er i lukket beta. Søk om tilgang.' })
    }
    const hash = await bcrypt.hash(password, 10)
    const verifyToken = crypto.randomBytes(32).toString('hex')
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, phone_number, address, auth_provider, email_verified, verify_token)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'email',false,$6) RETURNING id, name, email`,
      [name, email, hash, phone, address || null, verifyToken]
    )
    // Mark invite code as used
    if (codeUsed && inviteCode) {
      await pool.query(
        'UPDATE invite_codes SET used=true, used_by=$1, email=$2 WHERE UPPER(code)=UPPER($3)',
        [rows[0].id, email, inviteCode.trim()]
      )
      // Auto-whitelist the user
      await pool.query(
        `INSERT INTO invite_whitelist (email, approved, note) VALUES (LOWER($1), true, 'Invite code')
         ON CONFLICT (email) DO UPDATE SET approved=true`,
        [email]
      )
    }
    // Send verification email (non-blocking). returnTo plukkes opp av
    // /api/auth/verify-handleren etter at brukeren klikker lenken.
    sendVerificationEmail(email, name, verifyToken, returnTo)
    res.status(201).json({
      needsVerification: true,
      message: 'Sjekk e-posten din for å aktivere kontoen.',
      user: rows[0]
    })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'E-post allerede i bruk' })
    sendSafeError(res, e, 'auth')
  }
})

r.post('/login', validateLogin, async (req, res) => {
  const { email, password } = req.body
  try {
    if (!await checkWhitelist(email)) {
      return res.status(403).json({ error: 'invite_only', message: 'Vi er i lukket beta. Søk om tilgang.' })
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
    if (!rows[0]) return res.status(401).json({ error: 'Feil e-post eller passord' })
    if (!rows[0].password_hash) {
      const provider = rows[0].auth_provider === 'vipps' ? 'Vipps' : 'Google'
      return res.status(401).json({ error: `Denne kontoen bruker ${provider}-innlogging` })
    }
    const ok = await bcrypt.compare(password, rows[0].password_hash)
    if (!ok) return res.status(401).json({ error: 'Feil e-post eller passord' })
    // Block unverified email users (admins bypass)
    if (rows[0].auth_provider === 'email' && rows[0].email_verified === false && !rows[0].is_admin) {
      return res.status(403).json({
        error: 'E-posten din er ikke bekreftet. Sjekk innboksen din.',
        needsVerification: true,
        email: rows[0].email
      })
    }
    logLogin(rows[0], req, 'email')
    const session = await createSession(rows[0].id, req)
    setSessionCookies(res, session)
    res.json({ user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } })
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

r.get('/me', auth, async (req, res) => {
  // Kjernefelt kommer GARANTERT fra auth-middleware (req.user = id/name/email/
  // is_admin). Valgfrie kolonner hentes separat med try/catch slik at /me ALDRI
  // returnerer 500 og blokkerer login, selv om en kolonne mangler i den
  // Prisma-eide users-tabellen (f.eks. auth_provider/last_project_id droppet av
  // en Prisma db push). Login krever bare kjernefeltene.
  const me = {
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    is_admin: req.user.is_admin,
  }
  try {
    const { rows } = await pool.query(
      'SELECT auth_provider, last_project_id, created_at FROM users WHERE id=$1', [req.user.id]
    )
    if (rows[0]) Object.assign(me, rows[0])
  } catch (e) {
    console.warn('[auth/me] valgfrie kolonner utilgjengelig:', e.message)
  }
  res.json(me)
})

// PATCH /me — oppdater brukerprofil. Foreløpig kun last_project_id (cross-device
// persistens av sist valgte prosjekt). Verifiserer eierskap; null klarer feltet.
r.patch('/me', auth, async (req, res) => {
  const { last_project_id } = req.body || {}
  try {
    if (last_project_id) {
      const { rows: own } = await pool.query(
        'SELECT id FROM projects WHERE id=$1 AND user_id=$2', [last_project_id, req.user.id]
      )
      if (!own.length) return res.status(404).json({ error: 'Prosjekt ikke funnet' })
    }
    const { rows } = await pool.query(
      `UPDATE users SET last_project_id=$1 WHERE id=$2
       RETURNING id, name, email, auth_provider, is_admin, last_project_id, created_at`,
      [last_project_id || null, req.user.id]
    )
    res.json(rows[0])
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────

r.post('/refresh', requireTrustedOrigin, async (req, res) => {
  const refreshToken = parseCookies(req.headers.cookie)[REFRESH_COOKIE]
  if (!refreshToken) return res.status(401).json({ error: 'Refresh session missing' })
  try {
    const session = await rotateSession(refreshToken, req)
    if (!session) {
      clearSessionCookies(res)
      return res.status(401).json({ error: 'Invalid or expired refresh session' })
    }
    setSessionCookies(res, session)
    res.status(204).end()
  } catch {
    clearSessionCookies(res)
    res.status(401).json({ error: 'Ugyldig eller utløpt refresh token' })
  }
})

// ─── EMAIL VERIFICATION ───────────────────────────────────────────────────────

r.post('/exchange', requireTrustedOrigin, async (req, res) => {
  try {
    const result = await consumeExchangeCode(req.body?.code, req)
    if (!result) return res.status(401).json({ error: 'Invalid, used, or expired login code' })
    setSessionCookies(res, result.session)
    res.json({ user: result.user })
  } catch (e) {
    console.error('[auth/exchange]', e.message)
    res.status(500).json({ error: 'Could not create session' })
  }
})

r.post('/logout', requireTrustedOrigin, async (req, res) => {
  const cookies = parseCookies(req.headers.cookie)
  try {
    await revokeSession({ accessToken: cookies[ACCESS_COOKIE], refreshToken: cookies[REFRESH_COOKIE] })
  } finally {
    clearSessionCookies(res)
  }
  res.status(204).end()
})

// GET /auth/verify?token=xxx — verify email from link in mail
r.get('/verify', async (req, res) => {
  const { token, returnTo } = req.query
  const frontend = resolveReturnTo(returnTo)
  if (!token) return res.redirect(`${frontend}?error=missing_token`)

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE verify_token=$1', [token])
    if (!rows[0]) return res.redirect(`${frontend}?error=invalid_token`)

    await pool.query(
      'UPDATE users SET email_verified=true, verify_token=NULL WHERE id=$1',
      [rows[0].id]
    )

    // Auto-login: generate JWT and redirect (sender både ?token og ?oauth_token
    // for backward compat med gammel Vite-frontend)
    logLogin(rows[0], req, 'email-verify')
    res.redirect(await buildAuthRedirect(frontend, rows[0], { verified: 'true' }))
  } catch (e) {
    console.error('Verify error:', e)
    res.redirect(`${frontend}?error=verify_failed`)
  }
})

// POST /auth/resend-verification — resend verification email
r.post('/resend-verification', async (req, res) => {
  const { email, returnTo } = req.body
  if (!email) return res.status(400).json({ error: 'E-post mangler' })

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
    if (!rows[0]) return res.json({ message: 'Hvis kontoen finnes, er e-post sendt.' })
    if (rows[0].email_verified) return res.json({ message: 'E-post allerede bekreftet.' })

    const verifyToken = crypto.randomBytes(32).toString('hex')
    await pool.query('UPDATE users SET verify_token=$1 WHERE id=$2', [verifyToken, rows[0].id])
    sendVerificationEmail(email, rows[0].name, verifyToken, returnTo)
    res.json({ message: 'Verifiseringsmail sendt. Sjekk innboksen din.' })
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

// ─── VIPPS LOGIN ──────────────────────────────────────────────────────────────
// Docs: https://developer.vippsmobilepay.com/docs/APIs/login-api/

const VIPPS_BASE = process.env.VIPPS_BASE_URL || 'https://api.vipps.no'

// state → { returnTo | null }. createState() lager state'en og lagrer den
// klienten ba om å bli sendt tilbake til. Auto-rydding etter 10 min.
// Same-origin OAuth-callback. Klienten sender ?returnTo=<full-url> og vi
// validerer mot whitelist FØR vi redirecter — uten dette er endpointet et
// open-redirect og en phishing-vektor.
const ALLOWED_RETURN_HOSTS = [
  'yeeyoo.ai',
  'yeeyoo.no',
  'yeeyoo.eu',
  'app.yeeyoo.no',
  'yeeyoo-next.vercel.app',
]
const ALLOWED_LOCALHOST_PORTS = new Set(['3000', '5173'])

function resolveReturnTo(requested) {
  const fallbackOrigin = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000')
  if (!fallbackOrigin) throw new Error('FRONTEND_URL mangler')
  const fallback = new URL('/auth/callback', fallbackOrigin).toString()
  if (!requested) return fallback
  try {
    const u = new URL(requested)
    const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (isLocalhost) {
      return ALLOWED_LOCALHOST_PORTS.has(u.port) && u.pathname === '/auth/callback' ? u.toString() : fallback
    }
    if (u.protocol !== 'https:') return fallback
    const hostOk = ALLOWED_RETURN_HOSTS.includes(u.hostname)
    return hostOk && u.pathname === '/auth/callback' ? u.toString() : fallback
  } catch {
    return fallback
  }
}

// Bygg redirect-URL med both ?token og ?oauth_token. Den nye yeeyoo-next-appen
// leser ?token. Den gamle Vite-monolitten på app.yeeyoo.no leser ?oauth_token.
// Sender begge så vi ikke breaker den live mens migreringen pågår.
async function buildAuthRedirect(target, user, extraParams = {}) {
  const code = await createExchangeCode(user.id)
  const params = new URLSearchParams({
    code,
    ...extraParams,
  })
  const sep = target.includes('?') ? '&' : '?'
  return `${target}${sep}${params.toString()}`
}

r.get('/vipps', async (req, res) => {
  if (!process.env.VIPPS_CLIENT_ID) return res.status(503).json({ error: 'Vipps ikke konfigurert' })
  const redirectUri = process.env.VIPPS_REDIRECT_URI ||
    `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/vipps/callback`
  let state
  try { state = await createLoginOauthState('vipps', req.query.returnTo) }
  catch { return res.status(503).json({ error: 'Innlogging er midlertidig utilgjengelig' }) }
  const params = new URLSearchParams({
    client_id: process.env.VIPPS_CLIENT_ID,
    response_type: 'code',
    scope: 'openid name email phoneNumber',
    state,
    redirect_uri: redirectUri,
  })
  res.redirect(`${VIPPS_BASE}/access-management-1.0/access/oauth2/auth?${params}`)
})

r.get('/vipps/callback', async (req, res) => {
  const { code, state, error: vErr } = req.query
  const stored = await consumeLoginOauthState('vipps', state)
  const frontend = resolveReturnTo(stored?.return_to)
  if (!stored) return res.redirect(`${frontend}?error=invalid_state`)
  if (vErr) return res.redirect(`${frontend}?error=vipps_denied`)
  if (!code) return res.redirect(`${frontend}?error=no_code`)

  try {
    const redirectUri = process.env.VIPPS_REDIRECT_URI ||
      `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/vipps/callback`

    // Exchange code for token
    const tokenRes = await fetch(`${VIPPS_BASE}/access-management-1.0/access/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Merchant-Serial-Number': process.env.VIPPS_MSN || '',
        'Ocp-Apim-Subscription-Key': process.env.VIPPS_SUBSCRIPTION_KEY || '',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: process.env.VIPPS_CLIENT_ID,
        client_secret: process.env.VIPPS_CLIENT_SECRET,
      }),
    })
    if (!tokenRes.ok) { console.error('Vipps token:', await tokenRes.text()); return res.redirect(`${frontend}?error=vipps_token`) }
    const { access_token } = await tokenRes.json()

    // Fetch userinfo
    const userRes = await fetch(`${VIPPS_BASE}/vipps-userinfo-api/userinfo`, {
      headers: { 'Authorization': `Bearer ${access_token}`, 'Ocp-Apim-Subscription-Key': process.env.VIPPS_SUBSCRIPTION_KEY || '' },
    })
    if (!userRes.ok) return res.redirect(`${frontend}?error=vipps_userinfo`)
    const vi = await userRes.json()

    const user = await findOrCreateOAuthUser({
      sub: vi.sub,
      email: vi.email || `${vi.sub}@vipps.no`,
      name: [vi.given_name, vi.family_name].filter(Boolean).join(' ') || 'Vipps-bruker',
      provider: 'vipps',
    })

    logLogin(user, req, 'vipps')
    res.redirect(await buildAuthRedirect(frontend, user))
  } catch (e) {
    console.error('Vipps error:', e)
    res.redirect(`${frontend}?error=${e.message==='invite_only'?'invite_only':'vipps_server'}`)
  }
})

// ─── GOOGLE LOGIN ─────────────────────────────────────────────────────────────
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server

r.get('/google', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google ikke konfigurert' })
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/google/callback`
  let state
  try { state = await createLoginOauthState('google', req.query.returnTo) }
  catch { return res.status(503).json({ error: 'Innlogging er midlertidig utilgjengelig' }) }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

r.get('/google/callback', async (req, res) => {
  const { code, state, error: gErr } = req.query
  const stored = await consumeLoginOauthState('google', state)
  const frontend = resolveReturnTo(stored?.return_to)
  if (!stored) return res.redirect(`${frontend}?error=invalid_state`)
  if (gErr) return res.redirect(`${frontend}?error=google_denied`)
  if (!code) return res.redirect(`${frontend}?error=no_code`)

  try {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
      `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/google/callback`

    // Exchange code for token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) { console.error('Google token:', await tokenRes.text()); return res.redirect(`${frontend}?error=google_token`) }
    const { access_token } = await tokenRes.json()

    // Fetch userinfo
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    })
    if (!userRes.ok) return res.redirect(`${frontend}?error=google_userinfo`)
    const gi = await userRes.json()

    const user = await findOrCreateOAuthUser({
      sub: gi.sub,
      email: gi.email,
      name: gi.name || gi.email.split('@')[0],
      provider: 'google',
    })

    logLogin(user, req, 'google')
    res.redirect(await buildAuthRedirect(frontend, user))
  } catch (e) {
    console.error('Google OAuth error:', e.stack || e.message)
    res.redirect(`${frontend}?error=${e.message==='invite_only'?'invite_only':'google_server'}`)
  }
})

// ─── STATUS ──────────────────────────────────────────────────────────────────
r.get('/providers', (req, res) => {
  res.json({
    vipps: Boolean(process.env.VIPPS_CLIENT_ID),
    google: Boolean(process.env.GOOGLE_CLIENT_ID),
    inviteOnly: INVITE_ONLY,
  })
})

// ─── BETA SIGNUP (public — no auth needed) ───────────────────────────────────
r.post('/request-access', async (req, res) => {
  const { email, message } = req.body
  if (!email) return res.status(400).json({ error: 'E-post mangler' })
  try {
    const note = message
      ? `Beta-søknad: ${message.substring(0, 500)}`
      : 'Søkt via beta-skjema (ingen melding)'
    await pool.query(
      `INSERT INTO invite_whitelist (email, approved, note)
       VALUES (LOWER($1), false, $2)
       ON CONFLICT (email) DO UPDATE SET note=$2`,
      [email, note]
    )

    // Notify admin about new beta request
    sendEmail(
      ADMIN_EMAIL,
      `Ny beta-søknad — ${escapeHtml(email)}`,
      `<!DOCTYPE html>
      <html><head><meta charset="utf-8"></head>
      <body style="margin:0;padding:0;background:#050714;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
          <tr><td align="center">
            <table width="520" cellpadding="0" cellspacing="0" style="background:linear-gradient(145deg,rgba(12,17,48,.98),rgba(8,12,30,.98));border:1px solid rgba(255,255,255,.13);border-radius:16px;overflow:hidden;">
              <tr><td style="padding:32px 40px;">
                <div style="font-size:22px;font-weight:800;color:#f0f4ff;margin-bottom:16px;">Ny beta-søknad</div>
                <p style="color:#8892b0;font-size:15px;margin-bottom:8px;"><strong style="color:#c5cee0;">E-post:</strong> ${escapeHtml(email)}</p>
                <p style="color:#8892b0;font-size:15px;margin-bottom:24px;"><strong style="color:#c5cee0;">Melding:</strong> ${message ? escapeHtml(message.substring(0, 500)) : '<em>Ingen melding</em>'}</p>
                <a href="${process.env.FRONTEND_URL || 'https://app.yeeyoo.no'}/admin" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#2d5be3,#7c3aed);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">Administrer venteliste →</a>
                <hr style="border:none;border-top:1px solid rgba(255,255,255,.07);margin:24px 0;">
                <p style="color:#4a5278;font-size:11px;">Yeeyoo admin-varsel</p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>`
    ).catch(e => console.error('Admin notification failed:', e.message))

    res.json({ message: 'Takk! Vi sender deg en invitasjon når plassen din er klar.' })
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

// ─── ADMIN: Whitelist management ─────────────────────────────────────────────
r.get('/whitelist', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM invite_whitelist ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

r.post('/whitelist', auth, requireAdmin, async (req, res) => {
  const { email, approved = true } = req.body
  if (!email) return res.status(400).json({ error: 'E-post mangler' })
  try {
    const { rows } = await pool.query(
      `INSERT INTO invite_whitelist (email, approved, note)
       VALUES (LOWER($1), $2, 'Lagt til av admin')
       ON CONFLICT (email) DO UPDATE SET approved=$2
       RETURNING *`,
      [email, approved]
    )
    res.json(rows[0])
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

r.delete('/whitelist/:id', auth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM invite_whitelist WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    sendSafeError(res, e, 'auth')
  }
})

export default r
