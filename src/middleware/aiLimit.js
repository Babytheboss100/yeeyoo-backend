// AI-bruksgrenser per bruker (kostnadskontroll mot Anthropic-overforbruk).
//
// To eksporter:
//   checkAILimit(endpointType, opts?) — Express-middleware. Slår opp brukerens
//     tier, teller vellykkede kall i vinduet, og returnerer 429 hvis overskredet.
//     Logger throttles. Legger { tier, limit, window, current } på req.aiUsage.
//   logAIUsage({ userId, endpoint, tokensIn, tokensOut, cost, status }) — kalles
//     fra rute-handlere ETTER et vellykket Anthropic-kall for å logge faktisk bruk.
//
// Tabellen ai_usage opprettes manuelt i Render Shell (se MIGRATION nederst).
// Hvis tabellen ikke finnes enda feiler tellingen mykt (fail-open) — produktet
// fortsetter å fungere ubegrenset inntil migrasjonen er kjørt.

import crypto from 'crypto'
import { pool } from '../db.js'

// ─── Kostnad ─────────────────────────────────────────────────────────────────
// Claude Sonnet 4: $3/M input, $15/M output. Brukes som standardrate også for
// andre Tony-providere (kostnad er for sporing/innsikt, ikke fakturering).
const PRICE_IN = 3 / 1_000_000
const PRICE_OUT = 15 / 1_000_000

export function estimateCost(tokensIn = 0, tokensOut = 0) {
  return +(((tokensIn || 0) * PRICE_IN) + ((tokensOut || 0) * PRICE_OUT)).toFixed(4)
}

// ─── Tiers ─────────────────────────────────────────────────────────────────--
// subscriptions.plan kan være norsk (starter/vekst/bedrift) ELLER portugisisk
// (iniciante/pro/empresa) avhengig av marked. Normaliser begge til kanoniske
// tiers. Ukjent/null → free.
const TIER_ALIASES = {
  free: 'free',
  starter: 'tier1', iniciante: 'tier1',
  vekst: 'tier2', pro: 'tier2',
  bedrift: 'enterprise', empresa: 'enterprise',
}

// limit: -1 = ubegrenset (logges fortsatt). 0 = ikke tillatt (krever oppgradering).
const LIMITS = {
  free:       { tony_chat: { limit: 5,   window: '24h' }, brand_dna: { limit: 1,  window: '24h' }, smart_planner: { limit: 0,  window: '24h' }, seo: { limit: 0,  window: '30d' }, photoshoot: { limit: 0,  window: '24h' }, translate_image: { limit: 0,  window: '24h' } },
  tier1:      { tony_chat: { limit: 50,  window: '24h' }, brand_dna: { limit: 5,  window: '24h' }, smart_planner: { limit: 2,  window: '24h' }, seo: { limit: 5,  window: '30d' }, photoshoot: { limit: 10, window: '24h' }, translate_image: { limit: 10, window: '24h' } },
  tier2:      { tony_chat: { limit: 200, window: '24h' }, brand_dna: { limit: 20, window: '24h' }, smart_planner: { limit: 10, window: '24h' }, seo: { limit: 20, window: '30d' }, photoshoot: { limit: 50, window: '24h' }, translate_image: { limit: 50, window: '24h' } },
  enterprise: { tony_chat: { limit: -1,  window: '24h' }, brand_dna: { limit: -1, window: '24h' }, smart_planner: { limit: -1, window: '24h' }, seo: { limit: -1, window: '30d' }, photoshoot: { limit: -1, window: '24h' }, translate_image: { limit: -1, window: '24h' } },
}

const WINDOW_SQL = { '24h': "INTERVAL '24 hours'", '30d': "INTERVAL '30 days'" }
const WINDOW_MS = { '24h': 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }

async function resolveTier(req) {
  // Admin → enterprise (ubegrenset, men logges).
  if (req.user?.is_admin) return 'enterprise'
  const { rows } = await pool.query(
    'SELECT plan, status FROM subscriptions WHERE user_id=$1', [req.user.id]
  )
  const sub = rows[0]
  // Kun aktive abonnement gir oppgradert tier; ellers free.
  if (!sub || sub.status !== 'active') return 'free'
  return TIER_ALIASES[sub.plan] || 'free'
}

export async function logAIUsage({ userId, endpoint, tokensIn = 0, tokensOut = 0, cost = null, status = 'success' }) {
  try {
    const costUsd = cost == null ? estimateCost(tokensIn, tokensOut) : cost
    await pool.query(
      `INSERT INTO ai_usage (id, user_id, endpoint, tokens_in, tokens_out, cost_usd, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [crypto.randomUUID(), userId, endpoint, tokensIn || 0, tokensOut || 0, costUsd, status]
    )
  } catch (e) {
    // Aldri la logging ta ned et ellers vellykket kall.
    console.error('[logAIUsage] feilet:', e.message)
  }
}

async function nextReset(userId, endpoint, window) {
  try {
    const { rows } = await pool.query(
      `SELECT MIN(created_at) + ${WINDOW_SQL[window]} AS resets_at FROM ai_usage
       WHERE user_id=$1 AND endpoint=$2 AND status='success'
         AND created_at >= NOW() - ${WINDOW_SQL[window]}`,
      [userId, endpoint]
    )
    if (rows[0]?.resets_at) return new Date(rows[0].resets_at).toISOString()
  } catch { /* faller gjennom */ }
  return new Date(Date.now() + WINDOW_MS[window]).toISOString()
}

/**
 * Express-middleware. Bruk: r.post('/x', auth, checkAILimit('tony_chat'), handler)
 * @param {string} endpointType - tony_chat | brand_dna | smart_planner | seo
 * @param {{ skip?: (req)=>boolean }} [opts] - skip=true hopper over sjekk OG telling
 *        (f.eks. SEO 'save'-action som ikke kaller AI).
 */
export function checkAILimit(endpointType, opts = {}) {
  return async (req, res, next) => {
    try {
      if (opts.skip && opts.skip(req)) return next()

      const tier = await resolveTier(req)
      const rule = (LIMITS[tier] || LIMITS.free)[endpointType] || { limit: 0, window: '24h' }
      req.aiUsage = { endpointType, tier, limit: rule.limit, window: rule.window }

      if (rule.limit === -1) return next() // ubegrenset

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ai_usage
         WHERE user_id=$1 AND endpoint=$2 AND status='success'
           AND created_at >= NOW() - ${WINDOW_SQL[rule.window]}`,
        [req.user.id, endpointType]
      )
      const current = rows[0].count
      req.aiUsage.current = current

      if (current >= rule.limit) {
        await logAIUsage({ userId: req.user.id, endpoint: endpointType, status: 'throttled' })
        const resets_at = await nextReset(req.user.id, endpointType, rule.window)
        return res.status(429).json({
          error: rule.limit === 0
            ? 'Denne funksjonen krever en oppgradert plan.'
            : `Du har nådd grensen (${rule.limit} per ${rule.window === '24h' ? 'dag' : 'måned'}).`,
          current,
          limit: rule.limit,
          resets_at,
        })
      }
      next()
    } catch (e) {
      // Fail-open: en transient DB-feil (eller manglende ai_usage-tabell før
      // migrasjon) skal ikke blokkere alle AI-funksjoner. Logges for synlighet.
      console.error('[checkAILimit] fail-open:', e.message)
      next()
    }
  }
}
