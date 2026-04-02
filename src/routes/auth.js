import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { sendVerificationEmail } from '../services/email.js'

const r = Router()

const signToken = (user) =>
  jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' })

// Helper: find or create user from OAuth provider
async function findOrCreateOAuthUser({ sub, email, name, provider }) {
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
    `INSERT INTO users (name, email, ${col}, auth_provider) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, email, sub, provider]
  )
  return rows[0]
}

// ─── EMAIL/PASSWORD ───────────────────────────────────────────────────────────

r.post('/register', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'Mangler felt' })
  try {
    const hash = await bcrypt.hash(password, 10)
    const verifyToken = crypto.randomBytes(32).toString('hex')
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, auth_provider, email_verified, verify_token)
       VALUES ($1,$2,$3,'email',false,$4) RETURNING id, name, email`,
      [name, email, hash, verifyToken]
    )
    // Send verification email (non-blocking)
    sendVerificationEmail(email, name, verifyToken)
    res.status(201).json({
      needsVerification: true,
      message: 'Sjekk e-posten din for å aktivere kontoen.',
      user: rows[0]
    })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'E-post allerede i bruk' })
    res.status(500).json({ error: e.message })
  }
})

r.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
    if (!rows[0]) return res.status(401).json({ error: 'Feil e-post eller passord' })
    if (!rows[0].password_hash) {
      const provider = rows[0].auth_provider === 'vipps' ? 'Vipps' : 'Google'
      return res.status(401).json({ error: `Denne kontoen bruker ${provider}-innlogging` })
    }
    const ok = await bcrypt.compare(password, rows[0].password_hash)
    if (!ok) return res.status(401).json({ error: 'Feil e-post eller passord' })
    // Block unverified email users
    if (rows[0].auth_provider === 'email' && rows[0].email_verified === false) {
      return res.status(403).json({
        error: 'E-posten din er ikke bekreftet. Sjekk innboksen din.',
        needsVerification: true,
        email: rows[0].email
      })
    }
    res.json({ token: signToken(rows[0]), user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

r.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, auth_provider, created_at FROM users WHERE id=$1', [req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Bruker ikke funnet' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── EMAIL VERIFICATION ───────────────────────────────────────────────────────

// GET /auth/verify?token=xxx — verify email from link in mail
r.get('/verify', async (req, res) => {
  const { token } = req.query
  const frontend = process.env.FRONTEND_URL || 'https://app.yeeyoo.no'
  if (!token) return res.redirect(`${frontend}?error=missing_token`)

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE verify_token=$1', [token])
    if (!rows[0]) return res.redirect(`${frontend}?error=invalid_token`)

    await pool.query(
      'UPDATE users SET email_verified=true, verify_token=NULL WHERE id=$1',
      [rows[0].id]
    )

    // Auto-login: generate JWT and redirect
    const jwt_token = signToken(rows[0])
    res.redirect(`${frontend}?oauth_token=${jwt_token}&verified=true`)
  } catch (e) {
    console.error('Verify error:', e)
    res.redirect(`${frontend}?error=verify_failed`)
  }
})

// POST /auth/resend-verification — resend verification email
r.post('/resend-verification', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'E-post mangler' })

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
    if (!rows[0]) return res.json({ message: 'Hvis kontoen finnes, er e-post sendt.' })
    if (rows[0].email_verified) return res.json({ message: 'E-post allerede bekreftet.' })

    const verifyToken = crypto.randomBytes(32).toString('hex')
    await pool.query('UPDATE users SET verify_token=$1 WHERE id=$2', [verifyToken, rows[0].id])
    sendVerificationEmail(email, rows[0].name, verifyToken)
    res.json({ message: 'Verifiseringsmail sendt. Sjekk innboksen din.' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── VIPPS LOGIN ──────────────────────────────────────────────────────────────
// Docs: https://developer.vippsmobilepay.com/docs/APIs/login-api/

const VIPPS_BASE = process.env.VIPPS_BASE_URL || 'https://api.vipps.no'
const pendingStates = new Map()

function createState() {
  const state = crypto.randomBytes(20).toString('hex')
  pendingStates.set(state, Date.now())
  setTimeout(() => pendingStates.delete(state), 600000)
  return state
}

r.get('/vipps', (req, res) => {
  if (!process.env.VIPPS_CLIENT_ID) return res.status(503).json({ error: 'Vipps ikke konfigurert' })
  const redirectUri = process.env.VIPPS_REDIRECT_URI ||
    `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/vipps/callback`
  const state = createState()
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
  const frontend = process.env.FRONTEND_URL || 'https://app.yeeyoo.no'
  if (vErr) return res.redirect(`${frontend}?error=vipps_denied`)
  if (!state || !pendingStates.has(state)) return res.redirect(`${frontend}?error=invalid_state`)
  pendingStates.delete(state)
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

    res.redirect(`${frontend}?oauth_token=${signToken(user)}&oauth_name=${encodeURIComponent(user.name)}`)
  } catch (e) {
    console.error('Vipps error:', e)
    res.redirect(`${frontend}?error=vipps_server`)
  }
})

// ─── GOOGLE LOGIN ─────────────────────────────────────────────────────────────
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server

r.get('/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google ikke konfigurert' })
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/google/callback`
  const state = createState()
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
  const frontend = process.env.FRONTEND_URL || 'https://app.yeeyoo.no'
  if (gErr) return res.redirect(`${frontend}?error=google_denied`)
  if (!state || !pendingStates.has(state)) return res.redirect(`${frontend}?error=invalid_state`)
  pendingStates.delete(state)
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

    res.redirect(`${frontend}?oauth_token=${signToken(user)}&oauth_name=${encodeURIComponent(user.name)}`)
  } catch (e) {
    console.error('Google error:', e)
    res.redirect(`${frontend}?error=google_server`)
  }
})

// ─── STATUS ──────────────────────────────────────────────────────────────────
r.get('/providers', (req, res) => {
  res.json({
    vipps: Boolean(process.env.VIPPS_CLIENT_ID),
    google: Boolean(process.env.GOOGLE_CLIENT_ID),
  })
})

export default r
