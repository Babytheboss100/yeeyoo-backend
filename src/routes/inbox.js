// /api/inbox — IG/FB DM-mottak + svar (HOLO Sesjon J, #8).
//
// Webhook (GET verify + POST motta) er UAUTENTISERT (Meta). Resten krever auth
// og er tenant-isolert. Tony kan foreslå svar via /conversations/:id/suggest.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { verifyMetaSignature } from '../lib/whatsapp.js'
import { decryptToken } from '../lib/tokenCrypto.js'
import { logAudit } from '../lib/audit.js'
import { getMetaProvider } from '../lib/metaProvider.js'
import { checkAILimit } from '../middleware/aiLimit.js'

const r = Router()

// ─── Webhook: verifisering ───────────────────────────────────────────────────
r.get('/webhook', (req, res) => {
  const verifyToken = process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    return res.status(200).send(req.query['hub.challenge'])
  }
  return res.sendStatus(403)
})

// ─── Webhook: innkommende DM-er ──────────────────────────────────────────────
r.post('/webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}))
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(401)
  res.sendStatus(200)

  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return }
  try { await handleInbox(payload) } catch (e) { console.error('[inbox/webhook]', e.message) }
})

// Finn meta_account for mottakende side (page_id eller ig_user_id).
async function resolveAccountFor(platform, recipientId) {
  const col = platform === 'instagram' ? 'ig_user_id' : 'page_id'
  const { rows } = await pool.query(`SELECT * FROM meta_accounts WHERE ${col} = $1 LIMIT 1`, [recipientId])
  return rows[0] || null
}

async function upsertThread({ platform, recipientId, senderId, name }) {
  const { rows } = await pool.query(
    'SELECT * FROM inbox_threads WHERE platform=$1 AND recipient_id=$2 AND sender_id=$3 LIMIT 1',
    [platform, recipientId, senderId]
  )
  if (rows[0]) return rows[0]
  const account = await resolveAccountFor(platform, recipientId)
  // Unknown recipients are never assigned to an arbitrary tenant.
  if (!account?.user_id) return null
  const { rows: created } = await pool.query(
    `INSERT INTO inbox_threads (id, user_id, project_id, meta_account_id, platform, recipient_id, sender_id, customer_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [crypto.randomUUID(), account.user_id, account.project_id || null, account.id, platform, recipientId, senderId, name || null]
  )
  return created[0]
}

async function handleInbox(payload) {
  const platform = payload.object === 'instagram' ? 'instagram' : payload.object === 'page' ? 'facebook' : null
  if (!platform) return
  for (const entry of payload.entry || []) {
    for (const ev of entry.messaging || []) {
      const senderId = ev.sender?.id
      const recipientId = ev.recipient?.id
      const text = ev.message?.text
      if (!senderId || !recipientId || ev.message?.is_echo) continue // hopp egne ekko
      const thread = await upsertThread({ platform, recipientId, senderId, name: null })
      if (!thread) { console.warn('[inbox/webhook] unknown recipient ignored', recipientId); continue }
      await pool.query(
        `INSERT INTO inbox_messages (id, thread_id, direction, text, meta_message_id)
         VALUES ($1,$2,'inbound',$3,$4) ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING`,
        [crypto.randomUUID(), thread.id, text || `[${ev.message?.attachments ? 'vedlegg' : 'melding'}]`, ev.message?.mid || null]
      )
      await pool.query("UPDATE inbox_threads SET last_message_at=NOW(), status='open' WHERE id=$1", [thread.id])
    }
  }
}

// ─── Authed ──────────────────────────────────────────────────────────────────
r.use(auth)

// GET /conversations — tenant-isolert.
r.get('/conversations', async (req, res) => {
  try {
    const params = [req.user.id]
    let where = 't.user_id = $1'
    if (req.query.platform) { params.push(req.query.platform); where += ` AND t.platform = $${params.length}` }
    const { rows } = await pool.query(
      `SELECT t.id, t.platform, t.sender_id, t.customer_name, t.status, t.last_message_at, t.project_id
       FROM inbox_threads t WHERE ${where} ORDER BY t.last_message_at DESC LIMIT 200`, params
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

r.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { rows: own } = await pool.query('SELECT id FROM inbox_threads WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
    if (!own.length) return res.status(404).json({ error: 'Samtale ikke funnet' })
    const { rows } = await pool.query(
      `SELECT id, direction, text, meta_message_id, created_at FROM inbox_messages
       WHERE thread_id=$1 ORDER BY created_at ASC LIMIT 500`, [req.params.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /reply — { threadId, text }. Sender via Meta Send API.
r.post('/reply', async (req, res) => {
  const { threadId, text } = req.body || {}
  if (!threadId || !text) return res.status(400).json({ error: 'threadId og text kreves' })
  try {
    const { rows } = await pool.query('SELECT * FROM inbox_threads WHERE id=$1 AND user_id=$2', [threadId, req.user.id])
    if (!rows[0]) return res.status(404).json({ error: 'Samtale ikke funnet' })
    const thread = rows[0]
    if (!thread.meta_account_id) return res.status(409).json({ error: 'Ingen tilkoblet Meta-konto for denne samtalen' })
    const { rows: acc } = await pool.query('SELECT * FROM meta_accounts WHERE id=$1 AND user_id=$2', [thread.meta_account_id, req.user.id])
    if (!acc[0]) return res.status(409).json({ error: 'Meta-konto ikke funnet' })
    const token = decryptToken(acc[0].access_token)
    const sent = await getMetaProvider().reply({ account: acc[0], platform: thread.platform, recipientId: thread.sender_id, text, accessToken: token })

    await pool.query(
      `INSERT INTO inbox_messages (id, thread_id, direction, text, meta_message_id) VALUES ($1,$2,'outbound',$3,$4)`,
      [crypto.randomUUID(), thread.id, text, sent.id || null]
    )
    await pool.query('UPDATE inbox_threads SET last_message_at=NOW() WHERE id=$1', [thread.id])
    await logAudit({ userId: req.user.id, action: 'inbox.reply', resourceType: 'inbox_thread', resourceId: thread.id, metadata: { platform: thread.platform } })
    res.json({ ok: true, metaMessageId: sent.id || null, mock: sent.mock === true })
  } catch (e) {
    console.error('[inbox/reply]', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /conversations/:id/suggest — Tony foreslår et svar basert på siste meldinger.
r.post('/conversations/:id/suggest', checkAILimit('inbox'), async (req, res) => {
  try {
    const { rows: own } = await pool.query('SELECT * FROM inbox_threads WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
    if (!own.length) return res.status(404).json({ error: 'Samtale ikke funnet' })
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return res.status(503).json({ error: 'AI-provider ikke konfigurert' })
    const { rows: msgs } = await pool.query(
      'SELECT direction, text FROM inbox_messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 12', [req.params.id]
    )
    const transcript = msgs.reverse().map((m) => `${m.direction === 'inbound' ? 'Kunde' : 'Oss'}: ${m.text}`).join('\n')

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: 'Du er en hjelpsom social media manager. Foreslå ett kort, vennlig og profesjonelt svar på siste kundemelding. Svar KUN med selve meldingsteksten, ingen forklaring.',
        messages: [{ role: 'user', content: `Samtale:\n${transcript}\n\nForeslå vårt neste svar:` }],
      }),
    })
    const data = await aiRes.json().catch(() => ({}))
    if (!aiRes.ok) return res.status(502).json({ error: data?.error?.message || `anthropic ${aiRes.status}` })
    res.json({ suggestion: (data.content?.[0]?.text || '').trim() })
  } catch (e) {
    console.error('[inbox/suggest]', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default r
