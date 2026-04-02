import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

// ─── Get SEO profile for a project ──────────────────────────────────────────
r.get('/:projectId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM seo_profiles WHERE project_id=$1 AND user_id=$2',
      [req.params.projectId, req.user.id]
    )
    res.json(rows[0] || null)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Generate SEO profile using Claude ──────────────────────────────────────
r.post('/generate', async (req, res) => {
  const { projectId, companyName, companyOffer, industry, locations, targetCustomer, competitors } = req.body

  if (!projectId || !companyName || !industry) {
    return res.status(400).json({ error: 'Bedriftsnavn og bransje er påkrevd' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
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
    { "keyword": "søkeord her", "volume": 1200, "difficulty": "lav", "intent": "informasjonell" },
    ... (10 totalt, med realistiske norske søkevolum-estimater)
  ],
  "metaTitle": "SEO-optimert tittel under 60 tegn med viktigste søkeord",
  "metaDescription": "SEO-optimert metabeskrivelse under 155 tegn med CTA og søkeord",
  "blogIdeas": [
    { "title": "Blogginnlegg tittel optimert for søkeord", "targetKeyword": "hovedsøkeord", "outline": "Kort beskrivelse av vinkling og innhold" },
    ... (3 totalt)
  ],
  "actionChecklist": [
    { "action": "Konkret SEO-tiltak", "impact": "høy", "effort": "lav" },
    ... (5 totalt — prioriter quick wins)
  ]
}

VIKTIG:
- Søkevolum skal være realistiske estimater for NORSKE Google-søk
- Difficulty: "lav", "middels" eller "høy"
- Intent: "informasjonell", "transaksjonell", "navigasjon" eller "kommersiell"
- Impact: "høy", "middels" eller "lav"
- Effort: "lav", "middels" eller "høy"
- Svar KUN med JSON, ingen annen tekst`

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })

    if (!aiRes.ok) {
      const e = await aiRes.json()
      throw new Error(e.error?.message || 'Claude API feil')
    }

    const aiData = await aiRes.json()
    const rawText = aiData.content[0].text

    // Parse JSON from response (handle possible markdown wrapping)
    let seoData
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      seoData = JSON.parse(jsonMatch ? jsonMatch[0] : rawText)
    } catch {
      throw new Error('Kunne ikke parse AI-respons som JSON')
    }

    // Upsert SEO profile
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

    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
