import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// ─── Self-healing table creation ────────────────────────────────────────────
let tableVerified = false
async function ensureSmartplanTable() {
  if (tableVerified) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smartplan_businesses (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL,
      url TEXT,
      name TEXT,
      description TEXT,
      industry TEXT,
      target_audience TEXT,
      tone TEXT,
      goals TEXT,
      summary TEXT,
      raw_data TEXT,
      analysis JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  tableVerified = true
}

// ─── Analyse a URL ──────────────────────────────────────────────────────────
r.post('/analyse', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL mangler' })

  try {
    await ensureSmartplanTable()
    // Scrape via Jina Reader
    const jinaUrl = `https://r.jina.ai/${url}`
    const scrapeRes = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/plain' }
    })
    if (!scrapeRes.ok) throw new Error('Kunne ikke lese nettsiden')
    const rawText = await scrapeRes.text()

    // Truncate to avoid token limits
    const truncated = rawText.substring(0, 12000)

    // Analyse with Claude
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Anthropic API-nøkkel mangler')

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `Du er en ekspert på digital markedsføring og forretningsanalyse. Du analyserer nettsider og bedrifter for å lage innholdsstrategier for sosiale medier. Svar ALLTID på norsk. Svar KUN med gyldig JSON, ingen annen tekst.`,
        messages: [{
          role: 'user',
          content: `Analyser denne nettsiden og gi meg en komplett forretningsanalyse for sosiale medier-strategi.

NETTSIDE-INNHOLD:
${truncated}

Svar med denne eksakte JSON-strukturen:
{
  "name": "Bedriftsnavn",
  "industry": "Bransje",
  "summary": "Kort oppsummering av hva bedriften gjør (2-3 setninger)",
  "strengths": ["Styrke 1", "Styrke 2", "Styrke 3"],
  "opportunities": ["Mulighet 1", "Mulighet 2", "Mulighet 3"],
  "targetAudience": "Beskrivelse av målgruppen",
  "toneOfVoice": "Anbefalt tone (f.eks. profesjonell, uformell, inspirerende)",
  "contentPillars": ["Innholdspilar 1", "Innholdspilar 2", "Innholdspilar 3", "Innholdspilar 4"],
  "postingFrequency": "Anbefalt antall innlegg per uke med begrunnelse"
}`
        }]
      })
    })

    if (!claudeRes.ok) {
      const err = await claudeRes.json()
      throw new Error(err.error?.message || 'Claude-analyse feilet')
    }

    const claudeData = await claudeRes.json()
    const analysisText = claudeData.content[0].text

    // Parse JSON from Claude response
    let analysis
    try {
      // Extract JSON if wrapped in markdown code block
      const jsonMatch = analysisText.match(/```(?:json)?\s*([\s\S]*?)```/)
      analysis = JSON.parse(jsonMatch ? jsonMatch[1].trim() : analysisText.trim())
    } catch {
      throw new Error('Kunne ikke tolke analyse-resultatet')
    }

    // Save to database
    console.log('Smartplan analyse: saving to DB for user', req.user.id)
    const { rows } = await pool.query(
      `INSERT INTO smartplan_businesses (id, user_id, url, name, industry, summary, raw_data, analysis)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [
        req.user.id,
        url,
        analysis.name || null,
        analysis.industry || null,
        analysis.summary || null,
        truncated || null,
        JSON.stringify(analysis)
      ]
    )
    console.log('Smartplan analyse: saved OK, id:', rows[0]?.id)

    res.json(rows[0])
  } catch (e) {
    console.error('Smartplan analyse FULL ERROR:', e.stack)
    console.error('Smartplan analyse error detail:', e.message, '| code:', e.code, '| column:', e.column, '| table:', e.table)
    res.status(500).json({ error: e.message })
  }
})

// ─── Generate a month of posts ──────────────────────────────────────────────
r.post('/generate-month', async (req, res) => {
  const { businessId, year, month, postsPerWeek = 3 } = req.body
  if (!businessId) return res.status(400).json({ error: 'businessId mangler' })

  try {
    await ensureSmartplanTable()
    // Fetch the business analysis
    console.log('generate-month: fetching business', businessId, 'for user', req.user.id)
    const { rows: bizRows } = await pool.query(
      'SELECT * FROM smartplan_businesses WHERE id=$1 AND user_id=$2',
      [businessId, req.user.id]
    )
    if (!bizRows.length) return res.status(404).json({ error: 'Bedrift ikke funnet' })
    const biz = bizRows[0]
    const analysis = typeof biz.analysis === 'string' ? JSON.parse(biz.analysis) : (biz.analysis || {})
    console.log('generate-month: business found:', biz.name, '| analysis keys:', Object.keys(analysis))

    // Calculate post dates for the month
    const targetYear = year || new Date().getFullYear()
    const targetMonth = month || (new Date().getMonth() + 1)
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate()

    // Distribute posts across the month (Mon=1, Wed=3, Fri=5 pattern for 3/week)
    const postDays = []
    let dayPattern
    if (postsPerWeek <= 2) dayPattern = [1, 4]        // Mon, Thu
    else if (postsPerWeek <= 3) dayPattern = [1, 3, 5] // Mon, Wed, Fri
    else dayPattern = [1, 2, 3, 4, 5]                   // Mon-Fri

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(targetYear, targetMonth - 1, d)
      const dow = date.getDay() // 0=Sun, 1=Mon, ...
      if (dayPattern.includes(dow) && postDays.length < postsPerWeek * 5) {
        postDays.push(d)
      }
    }

    // Limit to roughly postsPerWeek * 4 weeks
    const maxPosts = postsPerWeek * 4
    const selectedDays = postDays.slice(0, maxPosts)

    // Platforms to rotate through
    const platforms = ['linkedin', 'instagram', 'facebook', 'tiktok']
    const pillars = analysis.contentPillars || ['Bransjenyheter', 'Tips', 'Kulissene', 'Kundehistorier']

    // Generate posts in batches to avoid rate limits
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Anthropic API-nøkkel mangler')

    const mNames = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember']

    // Generate all posts in one batch prompt for efficiency
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `Du er en ekspert på korte, fengende sosiale medier-innlegg. MAKS 3 setninger totalt. Ikke mer. Kutt alt unødvendig.

You are a world-class social media copywriter specializing in fintech and investment products. Generate posts that are SHORT, punchy, and conversion-focused.

BEDRIFT: ${analysis.name}
BRANSJE: ${analysis.industry}
OPPSUMMERING: ${analysis.summary}
MÅLGRUPPE: ${analysis.targetAudience || 'Generell'}
TONE: ${analysis.toneOfVoice || 'Profesjonell men menneskelig'}
INNHOLDSPILARER: ${pillars.join(', ')}
STYRKER: ${(analysis.strengths || []).join(', ')}

VIKTIG: LinkedIn maks 150 ord. Instagram maks 80 ord. Facebook maks 120 ord. TikTok maks 60 ord. Aldri mer. Telle nøye.

Rules:
- LinkedIn: MAKS 150 ord. Hook i første linje. 3-5 kulepunkter. Én tydelig CTA.
- Instagram: MAKS 80 ord. Emosjonell hook. Livsstil-vinkel. 5-8 relevante hashtags.
- Facebook: MAKS 120 ord. Historiebasert. Spørsmål som driver kommentarer.
- TikTok: MAKS 60 ord. Trendy, direkte, modige påstander.

Aldri bruk generiske CTAer som 'kommenter under'. Bruk spesifikke CTAer som 'Link i bio', 'Send oss en DM', eller direkte URLer.
Start alltid med en modig påstand eller overraskende statistikk.
Skriv på norsk (Bokmål).
Høres menneskelig ut, ikke korporativt.

Svar KUN med gyldig JSON-array.`,
        messages: [{
          role: 'user',
          content: `Generer ${selectedDays.length} unike innlegg for ${mNames[targetMonth - 1]} ${targetYear}.

For hvert innlegg, varier mellom plattformene og innholdspilarene.

Svar med en JSON-array med denne strukturen:
[
  {
    "index": 0,
    "platform": "linkedin|instagram|facebook|tiktok",
    "pillar": "innholdspilar",
    "content": "selve innholdet tilpasset plattformen"
  }
]

Generer nøyaktig ${selectedDays.length} innlegg. Varier innhold, pilarer og plattformer. Ikke gjenta samme type innhold.`
        }]
      })
    })

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text()
      console.error('generate-month: Claude API error:', claudeRes.status, errBody)
      throw new Error('Claude API feilet: ' + claudeRes.status)
    }

    const claudeData = await claudeRes.json()
    const genText = claudeData.content?.[0]?.text
    if (!genText) {
      console.error('generate-month: empty Claude response:', JSON.stringify(claudeData))
      throw new Error('Tom respons fra Claude')
    }
    console.log('generate-month: Claude returned', genText.length, 'chars')

    let generatedPosts
    try {
      const jsonMatch = genText.match(/```(?:json)?\s*([\s\S]*?)```/)
      generatedPosts = JSON.parse(jsonMatch ? jsonMatch[1].trim() : genText.trim())
    } catch (parseErr) {
      console.error('generate-month: JSON parse failed:', parseErr.message, '| raw:', genText.substring(0, 500))
      throw new Error('Kunne ikke tolke genererte innlegg')
    }
    console.log('generate-month: parsed', generatedPosts.length, 'posts')

    // Save posts to database
    const timeSlots = ['09:00', '12:00', '15:00', '18:00']
    const savedPosts = []

    for (let i = 0; i < Math.min(selectedDays.length, generatedPosts.length); i++) {
      const day = selectedDays[i]
      const post = generatedPosts[i]
      const platform = post.platform || platforms[i % platforms.length]
      const timeSlot = timeSlots[i % timeSlots.length]
      const scheduledAt = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}T${timeSlot}:00`

      const { rows } = await pool.query(
        `INSERT INTO posts (id, user_id, platform, content, status, scheduled_at, smartplan_business_id, ai_model)
         VALUES (gen_random_uuid(), $1, $2, $3, 'pending', $4, $5, 'claude') RETURNING *`,
        [req.user.id, platform, post.content, scheduledAt, businessId]
      )
      savedPosts.push(rows[0])
    }

    res.json({ posts: savedPosts, total: savedPosts.length })
  } catch (e) {
    console.error('Smartplan generate-month error:', e.stack || e.message)
    res.status(500).json({ error: e.message })
  }
})

// ─── Get calendar posts for smartplan ────────────────────────────────────────
r.get('/calendar', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear()
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1)
  const businessId = req.query.businessId
  const startDate = new Date(year, month - 1, 1)
  const endDate = new Date(year, month, 0, 23, 59, 59)

  try {
    await ensureSmartplanTable()
    let q = `
      SELECT p.*, sb.name as business_name, sb.industry as business_industry,
        COALESCE(p.scheduled_at, p.created_at) as calendar_date
      FROM posts p
      LEFT JOIN smartplan_businesses sb ON p.smartplan_business_id = sb.id
      WHERE p.user_id = $1
        AND p.smartplan_business_id IS NOT NULL
        AND COALESCE(p.scheduled_at, p.created_at) BETWEEN $2 AND $3
    `
    const params = [req.user.id, startDate, endDate]

    if (businessId) {
      q += ` AND p.smartplan_business_id = $4`
      params.push(businessId)
    }

    q += ` ORDER BY COALESCE(p.scheduled_at, p.created_at) ASC`

    const { rows } = await pool.query(q, params)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Update post schedule ────────────────────────────────────────────────────
r.patch('/posts/:id/schedule', async (req, res) => {
  const { scheduledAt } = req.body
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt mangler' })

  try {
    await ensureSmartplanTable()
    const { rows } = await pool.query(
      `UPDATE posts SET scheduled_at = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [scheduledAt, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Innlegg ikke funnet' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Get user's businesses ──────────────────────────────────────────────────
r.get('/businesses', async (req, res) => {
  try {
    await ensureSmartplanTable()
    console.log('Smartplan businesses: fetching for user', req.user.id)
    const { rows } = await pool.query(
      'SELECT * FROM smartplan_businesses WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    )
    console.log('Smartplan businesses: found', rows.length)
    res.json(rows)
  } catch (e) {
    console.error('Smartplan businesses FULL ERROR:', e.stack)
    console.error('Smartplan businesses error detail:', e.message, '| code:', e.code, '| table:', e.table)
    res.status(500).json({ error: e.message })
  }
})

export default r
