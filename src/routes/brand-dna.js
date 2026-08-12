import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { checkAILimit, logAIUsage } from '../middleware/aiLimit.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { profileFromLegacyBusiness } from '../marketing/profile.js'
import { saveMarketingProfile } from '../marketing/profileStore.js'
import { safeCrawl } from '../services/safeCrawler.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

const SYSTEM = 'Du er en norsk merkevare-strateg. Svar ALLTID med gyldig JSON uten markdown.'
const PROMPT = (url, scraped) => `Analyser bedriften fra ${url}. Tekst:\n${scraped.slice(0, 4000)}\nSvar med JSON: {"tone":"", "audience":{"age":"","demographics":"","interests":[]}, "values":[], "visualIdentity":{"colors":[],"fonts":[]}, "competitors":[], "summary":""}. Bruk null når grunnlaget mangler.`

async function scrapeUrl(url) {
    const { body: html } = await safeCrawl(url, { allowedTypes: ['text/html', 'application/xhtml+xml'], maxBytes: 1_000_000 })
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim()
    const visible = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ').replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
    return `TITLE: ${title}\n\nBODY: ${visible.slice(0, 4000)}`
}

r.post('/analyze', checkAILimit('brand_dna'), async (req, res) => {
  const { projectId, url } = req.body || {}
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Gyldig URL (med http/https) er påkrevd' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI-provider ikke konfigurert' })
  try {
    const scraped = await scrapeUrl(url)
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: PROMPT(url, scraped) }] }) })
    if (!aiResponse.ok) throw new Error(`anthropic ${aiResponse.status}: ${(await aiResponse.text()).slice(0, 200)}`)
    const aiData = await aiResponse.json()
    const rawText = aiData.content?.[0]?.text || ''
    let dna
    try { const match = rawText.match(/\{[\s\S]*\}/); dna = JSON.parse(match ? match[0] : rawText) } catch { throw new Error('Kunne ikke parse AI-respons som JSON') }
    const existing = await pool.query('SELECT id FROM businesses WHERE user_id=$1 AND url=$2 LIMIT 1', [req.user.id, url])
    let bizId = existing.rows[0]?.id
    if (bizId) {
      await pool.query('UPDATE businesses SET brand_dna=$1,project_id=COALESCE($2,project_id),updated_at=NOW() WHERE id=$3 AND user_id=$4', [JSON.stringify(dna), projectId || null, bizId, req.user.id])
    } else {
      bizId = crypto.randomUUID()
      await pool.query(`INSERT INTO businesses (id,user_id,project_id,url,name,industry,summary,brand_dna,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`, [bizId, req.user.id, projectId || null, url, dna.name || null, dna.industry || null, dna.summary || null, JSON.stringify(dna)])
    }
    if (projectId) {
      const profile = profileFromLegacyBusiness({ projectId, business: { url, brand_dna: dna, summary: dna.summary } })
      await saveMarketingProfile({ userId: req.user.id, projectId, profile, source: 'brand-dna' })
    }
    await logAIUsage({ userId: req.user.id, endpoint: 'brand_dna', tokensIn: aiData.usage?.input_tokens, tokensOut: aiData.usage?.output_tokens })
    res.json({ id: bizId, dna, url })
  } catch (error) { console.error('[brand-dna/analyze]', error.message); res.status(500).json({ error: error.message }) }
})

r.get('/history', async (req, res) => {
  const { projectId } = req.query
  try {
    const params = [req.user.id]
    let where = 'user_id=$1 AND brand_dna IS NOT NULL'
    if (projectId) { params.push(projectId); where += ` AND project_id=$${params.length}` }
    const { rows } = await pool.query(`SELECT id,url,brand_dna AS dna,summary,created_at,updated_at FROM businesses WHERE ${where} ORDER BY updated_at DESC LIMIT 50`, params)
    res.json(rows)
  } catch (error) { res.status(500).json({ error: error.message }) }
})

export default r
