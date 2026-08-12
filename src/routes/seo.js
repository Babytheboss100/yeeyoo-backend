import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership, requireProject, sendProjectError } from '../middleware/project.js'
import { checkAILimit, logAIUsage } from '../middleware/aiLimit.js'
import { beginDurableJob, durableResult } from '../jobs/jobCutover.js'
import { transitionJob } from '../jobs/jobStore.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

// /api/seo — SEO Agent. Per Sesjon I (PRIO 5) støttes nå to flyter:
//   1. Legacy (Smart Planner): POST /generate uten action → genererer full
//      profil basert på { companyName, industry, ... } og upserter
//      seo_profiles. Beholder kontrakten yeeyoo-frontend allerede bruker.
//   2. Wizard (yeeyoo-next): POST /generate med action='competitors' |
//      'strategy' | 'save' → 5-stegs flyt. Lagres i seo_reports som
//      historikk-arkiv.

// ─── GET /api/seo/:projectId ─────────────────────────────────────────
// Returnerer historikk-LISTE av seo_reports for prosjekt (yeeyoo-next-
// behov). Legacy seo_profiles-snapshot legges først i listen som
// sammendrag hvis den finnes, for ikke å tape data fra Smart Planner.
r.get('/:projectId', async (req, res) => {
  try {
    await requireProject(req, req.params.projectId)
    const { rows: reports } = await pool.query(
      `SELECT id, url, keyword, result, created_at
       FROM seo_reports
       WHERE project_id=$1 AND user_id=$2
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.params.projectId, req.user.id]
    )
    res.json(reports)
  } catch (e) {
    if (sendProjectError(res, e)) return
    console.error('[seo/:projectId]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /api/seo/generate ──────────────────────────────────────────
// Action-dispatcher. Tilbakekompatibel: hvis ingen action → legacy.
// Grensen 'seo' teller én SEO-rapport = action 'strategy' eller legacy-generering.
// 'save' kaller ikke AI, og 'competitors' er et billig hjelpesteg som logges som
// 'seo_competitors' (kostnadssporing) men ikke teller mot kvoten — ellers ville
// én wizard-kjøring (competitors + strategy) brent to kvoteenheter.
const seoSkip = (req) => ['save', 'competitors'].includes(req.body?.action)

r.post('/generate', checkAILimit('seo', { skip: seoSkip }), async (req, res) => {
  const { action } = req.body || {}

  // Wizard-grener
  if (action === 'competitors') return handleCompetitors(req, res)
  if (action === 'strategy')    return handleStrategy(req, res)
  if (action === 'save')        return handleSave(req, res)

  // Legacy (uendret kontrakt)
  return handleLegacyGenerate(req, res)
})

// ─── action='competitors' ────────────────────────────────────────────
async function handleCompetitors(req, res) {
  const { url, keyword } = req.body
  if (!keyword) return res.status(400).json({ error: 'keyword mangler' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI-provider ikke konfigurert' })

  const prompt = `Du er en SEO-ekspert. Gi en kort konkurrent-analyse for keywordet "${keyword}"${url ? ` (bedrift: ${url})` : ''}.

Returner JSON med NØYAKTIG denne formen:
{
  "competitors": [
    { "name": "Konkurrent navn", "url": "https://...", "note": "Kort vinkling — hvorfor de rangerer" }
  ],
  "suggestedKeywords": ["kw1", "kw2", "kw3", "kw4", "kw5"]
}

3-5 konkurrenter. 5-10 relaterte søkeord. Svar KUN JSON, ingen forklaring.`

  try {
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
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!aiRes.ok) throw new Error(`anthropic ${aiRes.status}`)
    const data = await aiRes.json()
    const raw = data.content?.[0]?.text || ''
    const json = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0])
    // Logg kostnad, men ikke mot 'seo'-kvoten (eget label).
    await logAIUsage({ userId: req.user.id, endpoint: 'seo_competitors', tokensIn: data.usage?.input_tokens, tokensOut: data.usage?.output_tokens })
    res.json({
      competitors: Array.isArray(json.competitors) ? json.competitors : [],
      suggestedKeywords: Array.isArray(json.suggestedKeywords) ? json.suggestedKeywords : [],
    })
  } catch (e) {
    console.error('[seo/generate competitors]', e.message)
    res.status(500).json({ error: e.message })
  }
}

// ─── action='strategy' ───────────────────────────────────────────────
async function handleStrategy(req, res) {
  const { projectId, url, keyword, keywords, competitors } = req.body
  if (!projectId) return res.status(400).json({ error: 'projectId kreves' })
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'keywords[] mangler' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI-provider ikke konfigurert' })

  const prompt = `Bygg en SEO-strategi for ${url || 'denne bedriften'} med fokus på keywordet "${keyword || keywords[0]}".

VALGTE KEYWORDS: ${keywords.join(', ')}
KONKURRENTER: ${Array.isArray(competitors) ? competitors.map((c) => c.name || c.url || c).join(', ') : '(ingen)'}

Returner JSON med NØYAKTIG denne formen:
{
  "summary": "Kort 2-3 setningers overview av strategien",
  "keywords": [
    { "keyword": "...", "volume": 1200, "difficulty": "lav|middels|høy" }
  ],
  "titleSuggestions": ["Tittel 1", "Tittel 2", "Tittel 3"],
  "metaDescriptions": ["Meta 1 (under 155 tegn)", "Meta 2", "Meta 3"],
  "contentIdeas": [
    { "title": "Blog-tittel", "angle": "Kort vinkling-beskrivelse" }
  ]
}

10 keywords, 3-5 titler, 3 metas (UNDER 155 tegn hver), 5 content-ideer. Svar KUN JSON.`

  let durable
  try {
    durable = await beginDurableJob({ userId: req.user.id, projectId, kind: 'seo', provider: 'anthropic', model: 'claude-sonnet-4-20250514', input: { url, keyword, keywords, competitors }, idempotencyKey: req.get('Idempotency-Key') || crypto.randomUUID() })
    const running = await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'queued', to: 'running' })
    if (!running) return res.status(409).json({ error: 'Jobben er allerede startet' })
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!aiRes.ok) throw new Error(`anthropic ${aiRes.status}`)
    const data = await aiRes.json()
    const raw = data.content?.[0]?.text || ''
    const json = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0])
    await logAIUsage({ userId: req.user.id, endpoint: 'seo', tokensIn: data.usage?.input_tokens, tokensOut: data.usage?.output_tokens })
    await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'running', to: 'succeeded', ...durableResult('seo', { report: json }, { tokensIn: data.usage?.input_tokens, tokensOut: data.usage?.output_tokens }) })
    res.json({ ...json, jobId: durable.id })
  } catch (e) {
    if (durable) await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'running', to: 'failed', error: e }).catch(() => {})
    console.error('[seo/generate strategy]', e.message)
    res.status(500).json({ error: e.message })
  }
}

// ─── action='save' ───────────────────────────────────────────────────
// Lagrer ferdig strategi i seo_reports for senere historikk.
async function handleSave(req, res) {
  const { projectId, url, result, keyword } = req.body
  if (!projectId || !result) {
    return res.status(400).json({ error: 'projectId og result er påkrevd' })
  }
  try {
    const id = crypto.randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO seo_reports (id, user_id, project_id, url, keyword, result)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, req.user.id, projectId, url || null, keyword || null, JSON.stringify(result)]
    )
    res.json({ saved: true, report: rows[0] })
  } catch (e) {
    console.error('[seo/generate save]', e.message)
    res.status(500).json({ error: e.message })
  }
}

// ─── Legacy /generate (Smart Planner) ────────────────────────────────
// Beholder den eksisterende kontrakten fra før Sesjon I så ingenting
// brekker. Yeeyoo-next bruker action-dispatch (over), gammel frontend
// bruker denne grenen.
async function handleLegacyGenerate(req, res) {
  const { projectId, companyName, companyOffer, industry, locations, targetCustomer, competitors } = req.body

  if (!projectId || !companyName || !industry) {
    return res.status(400).json({ error: 'Bedriftsnavn og bransje er påkrevd' })
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'AI API-nøkkel mangler' })

  const system = `Du er en norsk SEO-ekspert med dyp kunnskap om norsk marked, Google-søk i Norge, og digital markedsføring for norske bedrifter. Du svarer ALLTID med gyldig JSON — ingen markdown, ingen forklaringer utenfor JSON.`

  const user = `Analyser denne bedriften og generer en komplett SEO-profil:

BEDRIFT: ${companyName}
TILBUD: ${companyOffer || 'Ikke spesifisert'}
BRANSJE: ${industry}
LOKASJON/OMRÅDER: ${locations || 'Norge'}
TYPISK KUNDE: ${targetCustomer || 'Ikke spesifisert'}
KONKURRENTER: ${competitors || 'Ikke spesifisert'}

Generer dette som JSON med NØYAKTIG denne strukturen:
{
  "keywords": [
    { "keyword": "søkeord her", "volume": 1200, "difficulty": "lav", "intent": "informasjonell" }
  ],
  "metaTitle": "SEO-optimert tittel under 60 tegn med viktigste søkeord",
  "metaDescription": "SEO-optimert metabeskrivelse under 155 tegn med CTA og søkeord",
  "blogIdeas": [
    { "title": "Blogginnlegg tittel optimert for søkeord", "targetKeyword": "hovedsøkeord", "outline": "Kort beskrivelse av vinkling og innhold" }
  ],
  "actionChecklist": [
    { "action": "Konkret SEO-tiltak", "impact": "høy", "effort": "lav" }
  ]
}

Svar KUN med JSON, ingen annen tekst`

  try {
    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 2000, responseMimeType: 'application/json' }
      })
    })

    if (!aiRes.ok) {
      const e = await aiRes.json()
      throw new Error(e.error?.message || 'Gemini API feil')
    }

    const aiData = await aiRes.json()
    const rawText = aiData.candidates[0].content.parts[0].text

    let seoData
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      seoData = JSON.parse(jsonMatch ? jsonMatch[0] : rawText)
    } catch {
      throw new Error('Kunne ikke parse AI-respons som JSON')
    }

    const { rows } = await pool.query(`
      INSERT INTO seo_profiles (user_id, project_id, company_name, company_offer, industry, locations, target_customer, competitors, keywords, meta_title, meta_description, blog_ideas, action_checklist)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (project_id) DO UPDATE SET
        company_name=$3, company_offer=$4, industry=$5, locations=$6, target_customer=$7, competitors=$8,
        keywords=$9, meta_title=$10, meta_description=$11, blog_ideas=$12, action_checklist=$13, updated_at=NOW()
      RETURNING *
    `, [
      req.user.id, projectId, companyName, companyOffer || '', industry,
      locations || '', targetCustomer || '', competitors || '',
      JSON.stringify(seoData.keywords),
      seoData.metaTitle,
      seoData.metaDescription,
      JSON.stringify(seoData.blogIdeas),
      JSON.stringify(seoData.actionChecklist)
    ])

    // Legacy bruker Gemini — usageMetadata har andre feltnavn enn Anthropic.
    await logAIUsage({
      userId: req.user.id,
      endpoint: 'seo',
      tokensIn: aiData.usageMetadata?.promptTokenCount,
      tokensOut: aiData.usageMetadata?.candidatesTokenCount,
    })

    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

export default r
