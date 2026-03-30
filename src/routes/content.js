import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { generateContent, TEMPLATES, AI_MODELS } from '../services/generator.js'
import { getSubscription, PLANS } from './billing.js'

const r = Router()
r.use(auth)

// GET templates list
r.get('/templates', (req, res) => res.json(TEMPLATES))

// GET AI models
r.get('/ai-models', (req, res) => {
  const available = Object.values(AI_MODELS).map(m => ({
    ...m,
    configured: !!process.env[m.envKey]
  }))
  res.json(available)
})

// POST generate content
r.post('/generate', async (req, res) => {
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
            `INSERT INTO posts (user_id, project_id, platform, content, status)
             VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
            [req.user.id, projectId || null, platform, result.text]
          )
          return { ...rows[0], ai_model: modelId }
        })
      )
    )

    const posts = allResults.filter(r => r.status === 'fulfilled').map(r => r.value)
    const errors = allResults.filter(r => r.status === 'rejected').map(r => r.reason?.message)
    res.json({ posts, errors })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// POST generate image with Pollinations.ai (gratis)
r.post('/generate-image', async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'Mangler tekst' })
  try {
    const prompt = encodeURIComponent('Professional social media image, modern clean corporate style, no text: ' + text.substring(0, 200))
    const url = `https://image.pollinations.ai/prompt/${prompt}?width=1024&height=1024&nologo=true`
    res.json({ url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
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
