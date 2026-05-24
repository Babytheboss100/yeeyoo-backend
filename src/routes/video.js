// /api/video — AI-video MVP (fal.ai). HOLO Sesjon J.
//
// Asynkron: POST /generate submitter jobben og returnerer { id, status }.
// Klienten poller GET /:id til status=completed (video_url) eller failed.
// Authed + tenant-isolert.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { resolveModel, submitVideo, checkVideo } from '../lib/falVideo.js'
import { logAudit } from '../lib/audit.js'

const r = Router()
r.use(auth)

// POST /generate — { projectId?, prompt, model?, imageUrl? }
r.post('/generate', async (req, res) => {
  const { projectId, prompt, model, imageUrl } = req.body || {}
  if (!prompt && !imageUrl) return res.status(400).json({ error: 'prompt eller imageUrl kreves' })
  try {
    const falModel = resolveModel(model)
    const { requestId } = await submitVideo({ model: falModel, prompt, imageUrl })

    const id = crypto.randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO video_generations (id, user_id, project_id, model, prompt, image_url, status, fal_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,'processing',$7) RETURNING id, status, created_at`,
      [id, req.user.id, projectId || null, falModel, prompt || null, imageUrl || null, requestId]
    )
    await logAudit({
      userId: req.user.id, action: 'video.generate', resourceType: 'video_generation', resourceId: id,
      metadata: { model: falModel, hasImage: !!imageUrl },
    })
    res.status(202).json({ id: rows[0].id, status: 'processing' })
  } catch (e) {
    console.error('[video/generate]', e.message)
    res.status(502).json({ error: e.message })
  }
})

// GET /:id — status + video_url. Poller fal hvis fortsatt processing.
r.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM video_generations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]
    )
    const job = rows[0]
    if (!job) return res.status(404).json({ error: 'Jobb ikke funnet' })

    if (job.status === 'processing' && job.fal_request_id) {
      const check = await checkVideo({ model: job.model, requestId: job.fal_request_id })
      if (check.state === 'completed') {
        await pool.query(
          "UPDATE video_generations SET status='completed', video_url=$1, updated_at=NOW() WHERE id=$2",
          [check.videoUrl, job.id]
        )
        job.status = 'completed'
        job.video_url = check.videoUrl
      } else if (check.state === 'failed') {
        await pool.query(
          "UPDATE video_generations SET status='failed', error=$1, updated_at=NOW() WHERE id=$2",
          [check.error, job.id]
        )
        job.status = 'failed'
        job.error = check.error
      }
    }
    res.json({ id: job.id, status: job.status, videoUrl: job.video_url || null, error: job.error || null, model: job.model })
  } catch (e) {
    console.error('[video/:id]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET / — brukerens videohistorikk.
r.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, project_id, model, prompt, status, video_url, created_at
       FROM video_generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
