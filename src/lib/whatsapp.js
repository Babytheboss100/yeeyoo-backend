// WhatsApp Cloud API — multi-WABA kjernelogikk (HOLO Sesjon J).
//
// Direkte mot Meta Graph API (ingen BSP). Hver WABA er én rad i
// whatsapp_business_accounts med eget phone_number_id + system_user_token.
// Routing: locale → land → WABA, fallback NO.

import crypto from 'crypto'
import { pool } from '../db.js'
import { decryptToken } from './tokenCrypto.js'

const GRAPH = 'https://graph.facebook.com/v21.0'

// locale ('pt-BR' | 'no' | ...) → riktig WABA. Fallback: NO, så hvilken som
// helst aktiv konto.
export async function resolveWabaForLocale(locale, userId) {
  const cc = String(locale || '').toLowerCase().startsWith('pt') ? 'BR' : 'NO'
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_business_accounts
     WHERE active = TRUE AND country_code = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 1`,
    [cc, userId]
  )
  if (rows[0]) return rows[0]
  const { rows: fb } = await pool.query(
    `SELECT * FROM whatsapp_business_accounts
     WHERE active = TRUE AND user_id = $1 ORDER BY (country_code = 'NO') DESC, created_at ASC LIMIT 1`, [userId]
  )
  return fb[0] || null
}

// Innkommende webhook gir Metas phone_number_id → finn mottakende WABA.
export async function resolveWabaByPhoneNumberId(phoneNumberId) {
  const { rows } = await pool.query(
    'SELECT * FROM whatsapp_business_accounts WHERE phone_number_id = $1 LIMIT 1',
    [phoneNumberId]
  )
  return rows[0] || null
}

// Send tekst eller template via en gitt WABA. Kaster ved Meta-feil.
export async function sendWhatsAppMessage({ waba, to, text, template }) {
  const url = `${GRAPH}/${waba.phone_number_id}/messages`
  const payload = template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language || 'nb' },
          ...(template.components ? { components: template.components } : {}),
        },
      }
    : {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${decryptToken(waba.system_user_token)}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Meta API ${res.status}`)
    err.meta = data
    throw err
  }
  return { metaMessageId: data.messages?.[0]?.id || null, raw: data }
}

// Verifiser Metas X-Hub-Signature-256 (HMAC-SHA256 over rå body med app secret).
// Returnerer true hvis gyldig. Hvis META_APP_SECRET ikke er satt → true (dev).
export function verifyMetaSignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    // Feilet apent utenfor produksjon: uten secret ble enhver usignert payload
    // akseptert, og webhooken skriver til inbox_threads og whatsapp_conversations.
    console.warn('meta signature check skipped: secret missing')
    return false
  }
  if (!signatureHeader) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    return false
  }
}
