// Audit log — metadata-only revisjonsspor (HOLO Sesjon J).
//
// logAudit() er fire-and-forget: den kaster ALDRI, slik at en audit-feil aldri
// tar ned en ellers vellykket handling. Lagre KUN ikke-sensitiv metadata —
// aldri meldingsinnhold eller tokens. Bruk maskPhone() på telefonnumre.

import crypto from 'crypto'
import { pool } from '../db.js'
import { bumpStreak } from './streak.js'

export function maskPhone(p) {
  if (!p) return null
  const s = String(p)
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`
}

export async function logAudit({ userId = null, action, resourceType = null, resourceId = null, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), userId, action, resourceType, resourceId, JSON.stringify(metadata || {})]
    )
  } catch (e) {
    console.error('[audit] logging feilet:', e.message)
  }
  // Streak: enhver vellykket sosial post ('*.post') teller. DM-er
  // ('whatsapp.send') teller ikke. Fire-and-forget.
  if (action && action.endsWith('.post') && userId) {
    await bumpStreak(userId, { eventKey: `${action}:${resourceId || 'unknown'}` })
  }
}
