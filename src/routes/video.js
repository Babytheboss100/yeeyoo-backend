// /api/video — AI-video MVP (fal.ai). HOLO Sesjon J.
//
// Asynkron: POST /generate submitter jobben og returnerer { id, status }.
// Klienten poller GET /:id til status=completed (video_url) eller failed.
// Authed + tenant-isolert.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { resolveModel, submitVideo, checkVideo } from '../lib/falVideo.js'
import { logAudit } from '../lib/audit.js'
import { beginDurableJob, durableResult } from '../jobs/jobCutover.js'
import { transitionJob } from '../jobs/jobStore.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

// POST /generate — { projectId?, prompt, model?, imageUrl? }
r.post('/generate', async (req, res) => {
  const { projectId, prompt, model, imageUrl } = req.body || {}
  if (!projectId) return res.status(400).json({ error: 'projectId kreves' })
  if (!prompt && !imageUrl) return res.status(400).json({ error: 'prompt eller imageUrl kreves' })
  let durable
  try {
    const falModel = resolveModel(model)
    durable = await beginDurableJob({ userId: req.user.id, projectId, kind: 'video', provider: 'fal', model: falModel, input: { prompt, imageUrl }, idempotencyKey: req.get('Idempotency-Key') || crypto.randomUUID() })
    const running = await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'queued', to: 'running' })
    if (!running) return res.status(409).json({ error: 'Jobben er allerede startet' })
    const { requestId } = await submitVideo({ model: falModel, prompt, imageUrl })

    const id = durable.id
    const { rows } = await pool.query(
      `INSERT INTO video_generations (id, user_id, project_id, model, prompt, image_url, status, fal_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,'processing',$7) RETURNING id, status, created_at`,
      [id, req.user.id, projectId || null, falModel, prompt || null, imageUrl || null, requestId]
    )
    await pool.query('UPDATE ai_jobs SET provider_job_id=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 AND project_id=$4', [requestId, id, req.user.id, projectId])
    await logAudit({
      userId: req.user.id, action: 'video.generate', resourceType: 'video_generation', resourceId: id,
      metadata: { model: falModel, hasImage: !!imageUrl },
    })
    res.status(202).json({ id: rows[0].id, status: 'processing' })
  } catch (e) {
    if (durable) await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'running', to: 'failed', error: e }).catch(() => {})
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
        await transitionJob({ id: job.id, userId: req.user.id, projectId: job.project_id, from: 'running', to: 'succeeded', ...durableResult('video', { videoUrl: check.videoUrl }) })
      } else if (check.state === 'failed') {
        await pool.query(
          "UPDATE video_generations SET status='failed', error=$1, updated_at=NOW() WHERE id=$2",
          [check.error, job.id]
        )
        job.status = 'failed'
        job.error = check.error
        await transitionJob({ id: job.id, userId: req.user.id, projectId: job.project_id, from: 'running', to: 'failed', error: new Error(check.error || 'Video provider failed') })
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
