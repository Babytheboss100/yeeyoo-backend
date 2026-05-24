// /api/brand-dna — Brand DNA analyzer + history (Sesjon I, PRIO 2).
//
// Bygger på eksisterende `businesses`-tabell. Lagrer strukturert Brand DNA
// i ny `brand_dna` JSONB-kolonne (Sesjon I-migrasjon). `analysis` (text)
// brukes fortsatt av Smart Planner — vi setter ikke den her.
//
// Endpoints:
//   POST /api/brand-dna/analyze   { projectId, url }       → { dna }
//   GET  /api/brand-dna/history   ?projectId=…             → [{ id, url, brand_dna, created_at }]
//
// AI-provider: Anthropic Claude (same som smartplan.js). Hvis nøkkel mangler
// returnerer vi 503.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { checkAILimit, logAIUsage } from '../middleware/aiLimit.js'

const r = Router()
r.use(auth)

const SYSTEM = `Du er en norsk merkevare-strateg. Du analyserer nettsider og bygger en strukturert merkevareprofil. Svar ALLTID med gyldig JSON — ingen markdown, ingen forklaringer utenfor JSON-objektet.`

const PROMPT = (url, scraped) => `Analyser denne bedriften basert på nettsiden og tekstutdraget under.

URL: ${url}

TEKSTUTDRAG FRA NETTSIDEN (først 4000 tegn):
${scraped.slice(0, 4000)}

Generer en strukturert merkevareprofil som JSON med NØYAKTIG denne formen:
{
  "tone": "kort beskrivelse av tone — f.eks. 'Profesjonell, vennlig, faktabasert'",
  "audience": {
    "age": "f.eks. 25-45",
    "demographics": "kort beskrivelse",
    "interests": ["interesse1", "interesse2", "interesse3"]
  },
  "values": ["verdi1", "verdi2", "verdi3"],
  "visualIdentity": {
    "colors": ["#hex1", "#hex2", "#hex3"],
    "fonts": ["Font1", "Font2"]
  },
  "competitors": ["konkurrent1", "konkurrent2", "konkurrent3"],
  "summary": "Ett-avsnitts oppsummering av merkevarens posisjonering"
}

VIKTIG:
- Bruk realistiske farger fra det du faktisk ser i HTMLen (CSS-vars, inline-styles)
- Konkurrenter: tipp 3 sannsynlige basert på bransje/posisjonering
- Hvis du ikke har grunnlag for å gjette: bruk null for det feltet, ikke finn på data
- Svar KUN med JSON, ingen annen tekst`

// ── URL-scraper ──────────────────────────────────────────────────────
// Henter HTML, ekstraherer title + meta-description + visible body-tekst.
// Bruker regex (ingen cheerio-dep). 10s timeout.

async function scrapeUrl(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; YeeyooBrandBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()

    // Plukk ut metadata
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim()
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [, ''])[1]
    const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [, ''])[1]

    // Strip script + style + tags, normaliser whitespace
    const visibleText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    return [
      `TITLE: ${title}`,
      desc && `DESCRIPTION: ${desc}`,
      ogDesc && `OG_DESCRIPTION: ${ogDesc}`,
      `BODY: ${visibleText.slice(0, 4000)}`,
    ].filter(Boolean).join('\n\n')
  } finally {
    clearTimeout(timer)
  }
}

// ── POST /analyze ────────────────────────────────────────────────────
r.post('/analyze', checkAILimit('brand_dna'), async (req, res) => {
  const { projectId, url } = req.body || {}
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Gyldig URL (med http/https) er påkrevd' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI-provider ikke konfigurert' })

  try {
    // 1) Scrape
    let scraped = ''
    try {
      scraped = await scrapeUrl(url)
    } catch (e) {
      console.warn('[brand-dna/analyze] scrape feilet:', e.message)
      scraped = `(klarte ikke å hente HTML — bare URL er kjent: ${url})`
    }

    // 2) Kall Claude
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: 'user', content: PROMPT(url, scraped) }],
      }),
    })
    if (!aiRes.ok) {
      const body = await aiRes.text()
      throw new Error(`anthropic ${aiRes.status}: ${body.slice(0, 200)}`)
    }
    const aiData = await aiRes.json()
    const rawText = aiData.content?.[0]?.text || ''

    // 3) Parse JSON (Claude kan pakke i ```json — håndter begge)
    let dna
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      dna = JSON.parse(jsonMatch ? jsonMatch[0] : rawText)
    } catch {
      throw new Error('Kunne ikke parse AI-respons som JSON')
    }

    // 4) Upsert i businesses
    // Hvis bruker har eksisterende business med samme URL — oppdater den.
    // Ellers — lag ny rad.
    const { rows: existing } = await pool.query(
      'SELECT id FROM businesses WHERE user_id=$1 AND url=$2 LIMIT 1',
      [req.user.id, url]
    )

    let bizId
    if (existing[0]) {
      bizId = existing[0].id
      await pool.query(
        `UPDATE businesses
         SET brand_dna=$1, project_id=COALESCE($2, project_id), updated_at=NOW()
         WHERE id=$3`,
        [JSON.stringify(dna), projectId || null, bizId]
      )
    } else {
      bizId = crypto.randomUUID()
      await pool.query(
        `INSERT INTO businesses (id, user_id, project_id, url, name, industry, summary, brand_dna, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          bizId,
          req.user.id,
          projectId || null,
          url,
          dna.name || null,
          dna.industry || null,
          dna.summary || null,
          JSON.stringify(dna),
        ]
      )
    }

    // Logg AI-bruk (kostnadssporing + grensetelling)
    await logAIUsage({
      userId: req.user.id,
      endpoint: 'brand_dna',
      tokensIn: aiData.usage?.input_tokens,
      tokensOut: aiData.usage?.output_tokens,
    })

    res.json({ id: bizId, dna, url })
  } catch (e) {
    console.error('[brand-dna/analyze]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── GET /history ─────────────────────────────────────────────────────
r.get('/history', async (req, res) => {
  const { projectId } = req.query
  try {
    const params = [req.user.id]
    let where = 'user_id = $1 AND brand_dna IS NOT NULL'
    if (projectId) {
      params.push(projectId)
      where += ` AND project_id = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT id, url, brand_dna AS dna, summary, created_at, updated_at
       FROM businesses
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT 50`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('[brand-dna/history]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default r
