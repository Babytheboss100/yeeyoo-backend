import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { generateContent, generateImagePrompt, TEMPLATES, AI_MODELS } from '../services/generator.js'
import { INDUSTRY_TEMPLATES } from '../services/templates.js'
import { getSubscription, PLANS } from './billing.js'
import { createNotification } from './notifications.js'
import { validateGenerate } from '../middleware/sanitize.js'
import { renderBrandedImage } from '../services/imageRenderer.js'

const r = Router()
r.use(auth)

// GET templates list
r.get('/templates', (req, res) => res.json(TEMPLATES))

// GET industry templates library
r.get('/industry-templates', (req, res) => res.json(INDUSTRY_TEMPLATES))

// GET AI models
r.get('/ai-models', (req, res) => {
  const available = Object.values(AI_MODELS).map(m => ({
    ...m,
    configured: !!process.env[m.envKey]
  }))
  res.json(available)
})

// POST generate content
r.post('/generate', validateGenerate, async (req, res) => {
  const { projectId, templateId, customPrompt, platforms, extraContext, aiModels: selectedAIs } = req.body
  if (!platforms?.length) return res.status(400).json({ error: 'Velg minst én plattform' })

  const aiModels = selectedAIs?.length ? selectedAIs : ['claude']

  // ─── Sjekk plan-grenser ──────────────────────────────────────────────────
  const sub = await getSubscription(req.user.id)
  const plan = PLANS[sub.plan] || PLANS.free

  // Sjekk månedlig kvote
  const { rows: usageRows } = await pool.query(`
    SELECT COUNT(*) as count FROM posts
    WHERE user_id=$1 AND created_at >= date_trunc('month', NOW())
  `, [req.user.id])
  const usedThisMonth = parseInt(usageRows[0].count)
  const willGenerate = platforms.length * aiModels.length

  if (plan.postsPerMonth !== -1 && usedThisMonth + willGenerate > plan.postsPerMonth) {
    return res.status(403).json({
      error: `Månedlig kvote nådd (${plan.postsPerMonth} innlegg). Oppgrader planen din.`,
      upgradeRequired: true
    })
  }

  // Sjekk at AI-modellene er tillatt på planen
  const blockedAIs = aiModels.filter(m => !plan.aiModels.includes(m))
  if (blockedAIs.length) {
    return res.status(403).json({
      error: `${blockedAIs.join(', ')} krever en høyere plan. Oppgrader for å bruke alle AI-modeller.`,
      upgradeRequired: true
    })
  }

  // Build keys object from env
  const keys = {
    claude:   process.env.ANTHROPIC_API_KEY,
    gpt4o:    process.env.OPENAI_API_KEY,
    gemini:   process.env.GEMINI_API_KEY,
    grok:     process.env.GROK_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY
  }

  try {
    let project = null
    if (projectId) {
      const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2', [projectId, req.user.id])
      project = rows[0]
    }

    // Generate for each platform × each AI model in parallel
    const allResults = await Promise.allSettled(
      platforms.flatMap(platform =>
        aiModels.map(async modelId => {
          const results = await generateContent({ project, templateId, customPrompt, platform, extraContext, aiModels: [modelId], keys })
          const result = results[0]
          if (result.error) throw new Error(result.error)

          const { rows } = await pool.query(
            `INSERT INTO posts (id, user_id, project_id, platform, content, status)
             VALUES (gen_random_uuid(),$1,$2,$3,$4,'pending') RETURNING *`,
            [req.user.id, projectId || null, platform, result.text]
          )
          const post = rows[0]

          // Generate branded image in background (non-blocking)
          renderBrandedImage(result.text, platform, project?.name)
            .then(imageUrl => pool.query('UPDATE posts SET image_url=$1 WHERE id=$2', [imageUrl, post.id]))
            .catch(e => console.error('Branded image gen failed:', e.message))

          return { ...post, ai_model: modelId }
        })
      )
    )

    const posts = allResults.filter(r => r.status === 'fulfilled').map(r => r.value)
    const errors = allResults.filter(r => r.status === 'rejected').map(r => r.reason?.message)

    // Notify user
    if (posts.length) {
      createNotification(req.user.id, 'Innhold generert', `${posts.length} nye innlegg er klare for gjennomgang.`, 'success')
    }

    res.json({ posts, errors })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST generate image with Pollinations.ai (gratis)
r.post('/generate-image', async (req, res) => {
  const { text, projectId } = req.body
  if (!text) return res.status(400).json({ error: 'Mangler tekst' })
  try {
    let project = null
    if (projectId) {
      const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2', [projectId, req.user.id])
      project = rows[0]
    }
    const imagePrompt = generateImagePrompt(text, project)
    const cleanPrompt = imagePrompt.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim().substring(0, 100)
    const encoded = encodeURIComponent(cleanPrompt)
    const seed = Date.now() % 100000
    const url = `https://image.pollinations.ai/prompt/${encoded}?nologo=true&seed=${seed}`
    res.json({ url, prompt: cleanPrompt })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET daily ideas
r.get('/daily-ideas', async (req, res) => {
  const ideas = [
    {title:'Mythbuster Monday',desc:'Avkreft en vanlig myte i bransjen din med fakta og tall.',type:'mythbuster'},
    {title:'Kundehistorie',desc:'Del en ekte suksesshistorie fra en fornøyd kunde.',type:'testimonial'},
    {title:'Behind the Scenes',desc:'Vis hva som skjer bak kulissene i bedriften.',type:'features'},
    {title:'Statistikk-post',desc:'Del en overraskende statistikk relevant for målgruppen.',type:'statistics'},
    {title:'Tips & Triks',desc:'Del 3 praktiske tips publikummet kan bruke med en gang.',type:'problem-solution'},
    {title:'Før vs. Etter',desc:'Vis en transformasjon — resultat av produktet/tjenesten din.',type:'before-after'},
    {title:'FAQ Friday',desc:'Svar på det vanligste spørsmålet du får fra kunder.',type:'faq'},
    {title:'Bransjetrend',desc:'Kommenter en aktuell trend og hva den betyr for kundene dine.',type:'general'},
    {title:'Teamet bak',desc:'Presenter et teammedlem og hva de jobber med.',type:'features'},
  ]
  const doy = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000)
  const daily = [0,1,2].map(i => ideas[(doy + i * 3) % ideas.length])
  res.json(daily)
})

// GET all posts (queue + history)
r.get('/posts', async (req, res) => {
  const { status, projectId } = req.query
  let q = 'SELECT p.*, pr.name as project_name, pr.color as project_color FROM posts p LEFT JOIN projects pr ON p.project_id=pr.id WHERE p.user_id=$1'
  const params = [req.user.id]
  if (status) { q += ` AND p.status=$${params.length+1}`; params.push(status) }
  if (projectId) { q += ` AND p.project_id=$${params.length+1}`; params.push(projectId) }
  q += ' ORDER BY p.created_at DESC LIMIT 100'
  const { rows } = await pool.query(q, params)
  res.json(rows)
})

// GET calendar posts for a given month
r.get('/calendar', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear()
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1)
  const startDate = new Date(year, month - 1, 1)
  const endDate = new Date(year, month, 0, 23, 59, 59)
  try {
    const { rows } = await pool.query(`
      SELECT p.*, pr.name as project_name, pr.color as project_color,
        COALESCE(p.scheduled_at, p.created_at) as calendar_date
      FROM posts p
      LEFT JOIN projects pr ON p.project_id = pr.id
      WHERE p.user_id = $1
        AND COALESCE(p.scheduled_at, p.created_at) BETWEEN $2 AND $3
      ORDER BY COALESCE(p.scheduled_at, p.created_at) ASC
    `, [req.user.id, startDate, endDate])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH update post (edit content or change status)
r.patch('/posts/:id', async (req, res) => {
  const { content, status, scheduled_at } = req.body
  const fields = []
  const vals = []
  if (content !== undefined) { fields.push(`content=$${vals.length+1}`); vals.push(content) }
  if (status !== undefined) { fields.push(`status=$${vals.length+1}`); vals.push(status) }
  if (scheduled_at !== undefined) { fields.push(`scheduled_at=$${vals.length+1}`); vals.push(scheduled_at) }
  if (!fields.length) return res.status(400).json({ error: 'Ingen felt å oppdatere' })
  vals.push(req.params.id, req.user.id)
  const { rows } = await pool.query(
    `UPDATE posts SET ${fields.join(',')} WHERE id=$${vals.length-1} AND user_id=$${vals.length} RETURNING *`,
    vals
  )
  res.json(rows[0])
})

// DELETE post
r.delete('/posts/:id', async (req, res) => {
  await pool.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
  res.json({ ok: true })
})

// GET stats
r.get('/stats', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='pending') as pending,
      COUNT(*) FILTER (WHERE status='approved') as approved,
      COUNT(*) FILTER (WHERE status='published') as published,
      COUNT(*) FILTER (WHERE status='scheduled') as scheduled,
      COUNT(*) as total
    FROM posts WHERE user_id=$1
  `, [req.user.id])
  res.json(rows[0])
})

export default r
