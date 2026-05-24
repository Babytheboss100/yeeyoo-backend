// OAuth-providere uten app-review-krav (HOLO Sesjon J): LinkedIn, Reddit,
// Pinterest. Hver provider: enabled(), authorizeUrl(state), exchange(code),
// identity(token), store({userId, tokenData, identity}).
//
// Redirect-URI: ${BACKEND_URL}/api/oauth/{provider}/callback (må registreres i
// hver dev-app). Tokens lagres kryptert i {provider}_accounts.

import crypto from 'crypto'
import { pool } from '../db.js'
import { encryptToken } from './tokenCrypto.js'

const BACKEND = () => process.env.BACKEND_URL || 'https://yeeyoo-backend.onrender.com'
const redirectUri = (p) => `${BACKEND()}/api/oauth/${p}/callback`
const basic = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
const REDDIT_UA = process.env.REDDIT_USER_AGENT || 'yeeyoo-saas/1.0'

function expiresIso(tokenData) {
  return tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null
}

export const PROVIDERS = {
  // ─── LinkedIn ──────────────────────────────────────────────────────────────
  linkedin: {
    enabled: () => !!process.env.LINKEDIN_CLIENT_ID && !!process.env.LINKEDIN_CLIENT_SECRET,
    authorizeUrl(state) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.LINKEDIN_CLIENT_ID,
        redirect_uri: redirectUri('linkedin'),
        state,
        scope: 'openid profile w_member_social',
      })
      return `https://www.linkedin.com/oauth/v2/authorization?${q.toString()}`
    },
    async exchange(code) {
      const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: redirectUri('linkedin'),
          client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET,
        }).toString(),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.access_token) throw new Error(`linkedin token ${res.status}`)
      return d
    },
    async identity(accessToken) {
      const res = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.sub) throw new Error(`linkedin userinfo ${res.status}`)
      return { authorUrn: `urn:li:person:${d.sub}`, name: d.name }
    },
    async store({ userId, tokenData, identity }) {
      await pool.query(
        `INSERT INTO linkedin_accounts (id, user_id, author_urn, display_name, access_token, refresh_token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), userId, identity.authorUrn, identity.name || null,
         encryptToken(tokenData.access_token), tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null, expiresIso(tokenData)]
      )
    },
  },

  // ─── Reddit ────────────────────────────────────────────────────────────────
  reddit: {
    enabled: () => !!process.env.REDDIT_CLIENT_ID && !!process.env.REDDIT_CLIENT_SECRET,
    authorizeUrl(state) {
      const q = new URLSearchParams({
        client_id: process.env.REDDIT_CLIENT_ID,
        response_type: 'code', state, redirect_uri: redirectUri('reddit'),
        duration: 'permanent', scope: 'identity submit',
      })
      return `https://www.reddit.com/api/v1/authorize?${q.toString()}`
    },
    async exchange(code) {
      const res = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: { Authorization: basic(process.env.REDDIT_CLIENT_ID, process.env.REDDIT_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': REDDIT_UA },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri('reddit') }).toString(),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.access_token) throw new Error(`reddit token ${res.status}`)
      return d
    },
    async identity(accessToken) {
      const res = await fetch('https://oauth.reddit.com/api/v1/me', { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': REDDIT_UA } })
      const d = await res.json().catch(() => ({}))
      return { username: d.name || null }
    },
    async store({ userId, tokenData, identity }) {
      await pool.query(
        `INSERT INTO reddit_accounts (id, user_id, reddit_username, display_name, access_token, refresh_token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), userId, identity.username, identity.username,
         encryptToken(tokenData.access_token), tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null, expiresIso(tokenData)]
      )
    },
  },

  // ─── Pinterest ─────────────────────────────────────────────────────────────
  pinterest: {
    enabled: () => !!process.env.PINTEREST_CLIENT_ID && !!process.env.PINTEREST_CLIENT_SECRET,
    authorizeUrl(state) {
      const q = new URLSearchParams({
        client_id: process.env.PINTEREST_CLIENT_ID,
        redirect_uri: redirectUri('pinterest'),
        response_type: 'code', state,
        scope: 'boards:read,pins:read,pins:write,user_accounts:read',
      })
      return `https://www.pinterest.com/oauth/?${q.toString()}`
    },
    async exchange(code) {
      const res = await fetch('https://api.pinterest.com/v5/oauth/token', {
        method: 'POST',
        headers: { Authorization: basic(process.env.PINTEREST_CLIENT_ID, process.env.PINTEREST_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri('pinterest') }).toString(),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.access_token) throw new Error(`pinterest token ${res.status}`)
      return d
    },
    async identity(accessToken) {
      const res = await fetch('https://api.pinterest.com/v5/user_account', { headers: { Authorization: `Bearer ${accessToken}` } })
      const d = await res.json().catch(() => ({}))
      return { username: d.username || null }
    },
    async store({ userId, tokenData, identity }) {
      await pool.query(
        `INSERT INTO pinterest_accounts (id, user_id, pinterest_user_id, display_name, access_token, refresh_token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), userId, identity.username, identity.username,
         encryptToken(tokenData.access_token), tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null, expiresIso(tokenData)]
      )
    },
  },
}
