// /api/photoshoot — AI photoshoot via fal.ai FLUX 1.1 Pro (HOLO Sesjon J, #11).
// Async (samme mønster som video): submit → poll GET /:id.
// Authed + tenant-isolert + rate-limited + audited.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { checkAILimit, logAIUsage } from '../middleware/aiLimit.js'
import { falSubmit, falPoll, extractImageUrl, aspectToImageSize } from '../lib/fal.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

const FLUX_PRO = 'fal-ai/flux-pro/v1.1'
const PHOTOSHOOT_COST = 0.05 // estimat per bilde (USD)

// POST /generate — { prompt, project_id, scene_type?, aspect_ratio? }
r.post('/generate', checkAILimit('photoshoot'), async (req, res) => {
  const { prompt, project_id: projectId, scene_type: sceneType, aspect_ratio: aspectRatio } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt kreves' })
  try {
    const fullPrompt = sceneType
      ? `${prompt}. ${sceneType} photography, professional lighting, high detail.`
      : prompt
    const requestId = await falSubmit(FLUX_PRO, {
      prompt: fullPrompt,
      image_size: aspectToImageSize(aspectRatio || '1:1'),
      num_images: 1,
    })

    const id = crypto.randomUUID()
    await pool.query(
      `INSERT INTO photoshoot_generations (id, user_id, project_id, prompt, scene_type, aspect_ratio, status, fal_request_id, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
      [id, req.user.id, projectId || null, prompt, sceneType || null, aspectRatio || '1:1', requestId, PHOTOSHOOT_COST]
    )
    await logAIUsage({ userId: req.user.id, endpoint: 'photoshoot', cost: PHOTOSHOOT_COST })
    await logAudit({ userId: req.user.id, action: 'photoshoot.generate', resourceType: 'photoshoot_generation', resourceId: id, metadata: { sceneType: sceneType || null, aspectRatio: aspectRatio || '1:1' } })
    res.status(202).json({ id, status: 'pending' })
  } catch (e) {
    console.error('[photoshoot/generate]', e.message)
    res.status(502).json({ error: e.message })
  }
})

// GET /:id — status + image_url. Poller fal hvis fortsatt pending.
r.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM photoshoot_generations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]
    )
    const job = rows[0]
    if (!job) return res.status(404).json({ error: 'Jobb ikke funnet' })

    if (job.status === 'pending' && job.fal_request_id) {
      const check = await falPoll(FLUX_PRO, job.fal_request_id)
      if (check.state === 'completed') {
        const url = extractImageUrl(check.result)
        await pool.query(
          "UPDATE photoshoot_generations SET status='completed', image_url=$1, completed_at=NOW() WHERE id=$2",
          [url, job.id]
        )
        job.status = 'completed'; job.image_url = url
      } else if (check.state === 'failed') {
        await pool.query("UPDATE photoshoot_generations SET status='failed', error=$1 WHERE id=$2", [check.error, job.id])
        job.status = 'failed'; job.error = check.error
      }
    }
    res.json({ id: job.id, status: job.status, imageUrl: job.image_url || null, error: job.error || null })
  } catch (e) {
    console.error('[photoshoot/:id]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET / — historikk.
r.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, project_id, prompt, scene_type, aspect_ratio, status, image_url, created_at
       FROM photoshoot_generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default r
