// /api/whatsapp — multi-WABA WhatsApp Cloud API (HOLO Sesjon J).
//
// Webhook (GET verifisering + POST innkommende) er UAUTENTISERT (Meta kaller
// dem). Alt annet krever Bearer JWT og er tenant-isolert på req.user.id.
//
// Ingen auto-connect: WABA-rader settes manuelt i whatsapp_business_accounts.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import {
  resolveWabaForLocale,
  resolveWabaByPhoneNumberId,
  sendWhatsAppMessage,
  verifyMetaSignature,
} from '../lib/whatsapp.js'
import { logAudit, maskPhone } from '../lib/audit.js'

const r = Router()

// ─── Webhook: Meta-verifisering (GET) ────────────────────────────────────────
r.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }
  return res.sendStatus(403)
})

// ─── Webhook: innkommende meldinger/statuser (POST) ──────────────────────────
// req.body er en Buffer (express.raw montert på denne pathen i index.js) slik at
// signaturen kan verifiseres over rå bytes.
r.post('/webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}))
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'))) {
    return res.sendStatus(401)
  }
  res.sendStatus(200) // svar raskt — Meta retry-er ellers

  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return }
  try { await handleInbound(payload) } catch (e) {
    console.error('[whatsapp/webhook] inbound-feil:', e.message)
  }
})

async function handleInbound(payload) {
  if (payload.object !== 'whatsapp_business_account') return
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {}
      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) continue
      const waba = await resolveWabaByPhoneNumberId(phoneNumberId)
      if (!waba) { console.warn('[whatsapp] ukjent phone_number_id', phoneNumberId); continue }

      // Leveringsstatuser (sent/delivered/read/failed) på utgående meldinger
      for (const st of value.statuses || []) {
        if (st.id) {
          await pool.query(
            'UPDATE whatsapp_messages SET status=$1 WHERE meta_message_id=$2',
            [st.status, st.id]
          )
        }
      }

      // Innkommende meldinger fra kunder
      const contacts = value.contacts || []
      for (const msg of value.messages || []) {
        const from = msg.from
        const name = contacts.find((c) => c.wa_id === from)?.profile?.name || null
        const body = msg.text?.body || msg[msg.type]?.caption || `[${msg.type}]`
        const convo = await upsertInboundConversation(waba, from, name)
        await pool.query(
          `INSERT INTO whatsapp_messages (id, conversation_id, direction, message_body, meta_message_id, status)
           VALUES ($1, $2, 'inbound', $3, $4, 'received')`,
          [crypto.randomUUID(), convo.id, body, msg.id || null]
        )
        await pool.query(
          "UPDATE whatsapp_conversations SET last_message_at = NOW(), status = 'active' WHERE id = $1",
          [convo.id]
        )
      }
    }
  }
}

// v1: WABA-operatør = admin-bruker (Heljar eier begge numre). Flagget i SESJON-J-PLAN.
async function wabaOwnerUserId() {
  const { rows } = await pool.query('SELECT id FROM users WHERE is_admin = TRUE ORDER BY created_at ASC LIMIT 1')
  return rows[0]?.id || null
}

async function upsertInboundConversation(waba, customerPhone, customerName) {
  const { rows } = await pool.query(
    'SELECT * FROM whatsapp_conversations WHERE waba_account_id=$1 AND customer_phone=$2 LIMIT 1',
    [waba.id, customerPhone]
  )
  if (rows[0]) {
    if (customerName && !rows[0].customer_name) {
      await pool.query('UPDATE whatsapp_conversations SET customer_name=$1 WHERE id=$2', [customerName, rows[0].id])
    }
    return rows[0]
  }
  const language = waba.country_code === 'BR' ? 'pt-BR' : 'no'
  const { rows: created } = await pool.query(
    `INSERT INTO whatsapp_conversations (id, waba_account_id, user_id, customer_phone, customer_name, language)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [crypto.randomUUID(), waba.id, await wabaOwnerUserId(), customerPhone, customerName, language]
  )
  return created[0]
}

// ─── Alt under krever auth + er tenant-isolert ───────────────────────────────
r.use(auth)

// POST /send — send tekst/template via WABA valgt på locale (eller låst til en
// eksisterende samtale). Lagrer utgående melding under innloggende bruker.
r.post('/send', async (req, res) => {
  const { to, text, template, locale, projectId, conversationId } = req.body || {}
  if (!to || (!text && !template)) {
    return res.status(400).json({ error: 'to og text/template kreves' })
  }
  try {
    let convo = null
    let waba = null

    if (conversationId) {
      const { rows } = await pool.query(
        'SELECT * FROM whatsapp_conversations WHERE id=$1 AND user_id=$2',
        [conversationId, req.user.id]
      )
      if (!rows[0]) return res.status(404).json({ error: 'Samtale ikke funnet' })
      convo = rows[0]
      const { rows: w } = await pool.query('SELECT * FROM whatsapp_business_accounts WHERE id=$1', [convo.waba_account_id])
      waba = w[0]
    } else {
      waba = await resolveWabaForLocale(locale)
    }
    if (!waba || !waba.active) {
      return res.status(503).json({ error: 'Ingen aktiv WhatsApp-konto for denne ruten' })
    }

    const sent = await sendWhatsAppMessage({ waba, to, text, template })

    if (!convo) {
      convo = await upsertOutboundConversation({ waba, userId: req.user.id, projectId, customerPhone: to, locale })
    }
    await pool.query(
      `INSERT INTO whatsapp_messages (id, conversation_id, direction, message_body, template_name, meta_message_id, status)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'sent')`,
      [crypto.randomUUID(), convo.id, text || null, template?.name || null, sent.metaMessageId]
    )
    await pool.query('UPDATE whatsapp_conversations SET last_message_at = NOW() WHERE id = $1', [convo.id])

    await logAudit({
      userId: req.user.id,
      action: 'whatsapp.send',
      resourceType: 'whatsapp_conversation',
      resourceId: convo.id,
      metadata: {
        country: waba.country_code,
        to: maskPhone(to),
        template: template?.name || null,
        hasText: !!text,
        metaMessageId: sent.metaMessageId,
      },
    })

    res.json({ ok: true, conversationId: convo.id, metaMessageId: sent.metaMessageId })
  } catch (e) {
    console.error('[whatsapp/send]', e.message)
    res.status(502).json({ error: e.message })
  }
})

async function upsertOutboundConversation({ waba, userId, projectId, customerPhone, locale }) {
  const language = String(locale || '').toLowerCase().startsWith('pt')
    ? 'pt-BR'
    : (waba.country_code === 'BR' ? 'pt-BR' : 'no')
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_conversations (id, waba_account_id, user_id, project_id, customer_phone, language)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (waba_account_id, customer_phone) DO UPDATE SET last_message_at = NOW()
     RETURNING *`,
    [crypto.randomUUID(), waba.id, userId, projectId || null, customerPhone, language]
  )
  return rows[0]
}

// GET /accounts — WABA-er (uten system_user_token).
r.get('/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, country_code, phone_number, waba_id, phone_number_id, display_name,
              quality_rating, messaging_tier, active, created_at
       FROM whatsapp_business_accounts ORDER BY created_at ASC`
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /conversations — tenant-isolert liste for innlogget bruker.
r.get('/conversations', async (req, res) => {
  try {
    const params = [req.user.id]
    let where = 'c.user_id = $1'
    if (req.query.projectId) {
      params.push(req.query.projectId)
      where += ` AND c.project_id = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.customer_phone, c.customer_name, c.language, c.status, c.last_message_at,
              c.project_id, w.display_name AS waba_name, w.country_code
       FROM whatsapp_conversations c
       JOIN whatsapp_business_accounts w ON w.id = c.waba_account_id
       WHERE ${where} ORDER BY c.last_message_at DESC LIMIT 200`,
      params
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /conversations/:id/messages — verifiser eierskap først.
r.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { rows: own } = await pool.query(
      'SELECT id FROM whatsapp_conversations WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    if (!own.length) return res.status(404).json({ error: 'Samtale ikke funnet' })
    const { rows } = await pool.query(
      `SELECT id, direction, message_body, template_name, meta_message_id, status, created_at
       FROM whatsapp_messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 500`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
