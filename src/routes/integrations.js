// /api/integrations — Klaviyo + Mailchimp (HOLO Sesjon J, #9).
// Authed + tenant-isolert. API-nøkler krypteres ved connect, dekrypteres ved bruk.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { encryptToken, decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'
import {
  klaviyoSubscribe, klaviyoSendCampaign,
  mailchimpSubscribe, mailchimpSendCampaign,
} from '../lib/emailProviders.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

const PROVIDERS = ['klaviyo', 'mailchimp']

async function getIntegration(userId, provider) {
  const { rows } = await pool.query('SELECT * FROM email_integrations WHERE user_id=$1 AND provider=$2', [userId, provider])
  if (!rows[0]) return null
  return { ...rows[0], apiKey: decryptToken(rows[0].api_key) }
}

// POST /:provider/connect — { projectId?, apiKey, listId? }
// Mailchimp: server_prefix utledes fra nøkkel (key-dc).
r.post('/:provider/connect', async (req, res) => {
  const provider = req.params.provider
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  const { projectId, apiKey, listId } = req.body || {}
  if (!apiKey) return res.status(400).json({ error: 'apiKey kreves' })
  try {
    const serverPrefix = provider === 'mailchimp' ? (apiKey.split('-')[1] || null) : null
    await pool.query(
      `INSERT INTO email_integrations (id, user_id, project_id, provider, api_key, list_id, server_prefix)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET api_key=EXCLUDED.api_key, list_id=EXCLUDED.list_id, server_prefix=EXCLUDED.server_prefix, project_id=EXCLUDED.project_id, active=TRUE`,
      [crypto.randomUUID(), req.user.id, projectId || null, provider, encryptToken(apiKey), listId || null, serverPrefix]
    )
    await logAudit({ userId: req.user.id, action: 'integration.connect', resourceType: 'email_integration', resourceId: provider, metadata: { provider } })
    res.json({ ok: true, provider })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET / — koblede integrasjoner (uten nøkler).
r.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT provider, list_id, server_prefix, active, project_id, created_at
       FROM email_integrations WHERE user_id=$1`, [req.user.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /:provider/sync-contacts — { contacts:[{email,firstName?,lastName?}], listId? }
r.post('/:provider/sync-contacts', async (req, res) => {
  const provider = req.params.provider
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  const { contacts, listId } = req.body || {}
  if (!Array.isArray(contacts) || contacts.length === 0) return res.status(400).json({ error: 'contacts[] kreves' })
  try {
    const integ = await getIntegration(req.user.id, provider)
    if (!integ || !integ.active) return res.status(404).json({ error: `${provider} ikke koblet` })
    if (listId) integ.list_id = listId
    const fn = provider === 'klaviyo' ? klaviyoSubscribe : mailchimpSubscribe
    const result = await fn({ apiKey: integ.apiKey, serverPrefix: integ.server_prefix, listId: integ.list_id }, contacts)
    await logAudit({ userId: req.user.id, action: 'integration.sync', resourceType: 'email_integration', resourceId: provider, metadata: { provider, count: contacts.length } })
    res.json({ ok: true, provider, ...result })
  } catch (e) {
    console.error('[integrations/sync]', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /:provider/send-campaign — { subject, fromName, replyTo, html, listId? }
r.post('/:provider/send-campaign', async (req, res) => {
  const provider = req.params.provider
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  const { subject, fromName, replyTo, html, listId } = req.body || {}
  if (!subject || !html) return res.status(400).json({ error: 'subject og html kreves' })
  try {
    const integ = await getIntegration(req.user.id, provider)
    if (!integ || !integ.active) return res.status(404).json({ error: `${provider} ikke koblet` })
    if (listId) integ.list_id = listId
    const cfg = { apiKey: integ.apiKey, serverPrefix: integ.server_prefix, listId: integ.list_id }
    const payload = { subject, fromName, replyTo, html }
    const result = provider === 'klaviyo'
      ? await klaviyoSendCampaign(cfg, payload)
      : await mailchimpSendCampaign(cfg, payload)
    await logAudit({ userId: req.user.id, action: 'integration.campaign', resourceType: 'email_integration', resourceId: provider, metadata: { provider, subject } })
    res.json({ ok: true, provider, ...result })
  } catch (e) {
    console.error('[integrations/campaign]', e.message)
    res.status(e.statusCode || 502).json({ error: e.message })
  }
})

export default r
