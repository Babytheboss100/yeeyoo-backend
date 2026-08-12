import crypto from 'node:crypto'
import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { createTonyPlanV3 } from '../tony/planV3.js'
import { resumeExecution } from '../tony/executionGraph.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

const publicPlan = row => ({ ...row.graph, status: row.status, updatedAt: row.updated_at })

r.get('/', async (req, res) => {
  const { projectId } = req.query
  if (!projectId) return res.status(400).json({ error: 'projectId is required' })
  const { rows } = await pool.query(
    `SELECT id, status, graph, updated_at FROM tony_execution_plans
     WHERE project_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT 20`,
    [projectId, req.user.id]
  )
  res.json(rows.map(publicPlan))
})

r.post('/', async (req, res) => {
  const { projectId, objective, campaignId = null, budget = null, currency = null } = req.body || {}
  if (!projectId) return res.status(400).json({ error: 'projectId is required' })
  try {
    const plan = createTonyPlanV3({ userId: req.user.id, projectId, objective, campaignId, budget, currency })
    await pool.query(
      `INSERT INTO tony_execution_plans (id,user_id,project_id,campaign_id,schema_version,objective,status,graph)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [plan.id, req.user.id, projectId, campaignId, plan.schemaVersion, plan.objective, plan.status, plan]
    )
    res.status(201).json(plan)
  } catch (error) {
    if (['OBJECTIVE_REQUIRED', 'INVALID_BUDGET'].includes(error.code)) return res.status(400).json({ error: error.message, code: error.code })
    throw error
  }
})

r.post('/:id/resume', async (req, res) => {
  const { projectId } = req.body || {}
  if (!projectId) return res.status(400).json({ error: 'projectId is required' })
  const key = req.get('Idempotency-Key')
  if (!key || key.length > 200) return res.status(400).json({ error: 'Valid Idempotency-Key is required' })
  const { rows } = await pool.query(
    `SELECT graph FROM tony_execution_plans WHERE id=$1 AND project_id=$2 AND user_id=$3`,
    [req.params.id, projectId, req.user.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Tony plan not found' })
  const resume = resumeExecution(rows[0].graph)
  // Resume is intentionally advisory in Phase 12. A worker lease performs steps;
  // this endpoint never publishes, sends, spends, or marks work completed.
  res.json({ ...resume, idempotencyKey: key, executionStarted: false, message: 'Safe resume checkpoint created. Runnable steps await the worker.' })
})

r.get('/policy', async (req, res) => {
  const { projectId, campaignId } = req.query
  if (!projectId || !campaignId) return res.status(400).json({ error: 'projectId and campaignId are required' })
  const { rows } = await pool.query(
    `SELECT level,channels,max_budget,currency,version,updated_at FROM autopilot_policies
     WHERE project_id=$1 AND campaign_id=$2`, [projectId, campaignId]
  )
  res.json(rows[0] || { level: 0, channels: [], max_budget: null, currency: null, version: 0 })
})

r.put('/policy', async (req, res) => {
  const { projectId, campaignId, level } = req.body || {}
  if (!projectId || !campaignId || !Number.isInteger(level) || level < 0 || level > 3) return res.status(400).json({ error: 'Valid projectId, campaignId and level 0-3 are required' })
  // UI policy edits cannot bind channels/budget or forge action approval. Level 3
  // remains inert until a separately approved, fingerprint-bound action exists.
  const { rows } = await pool.query(
    `INSERT INTO autopilot_policies (id,project_id,campaign_id,level,channels,max_budget,currency,created_by)
     VALUES ($1,$2,$3,$4,'[]',NULL,NULL,$5)
     ON CONFLICT (project_id,campaign_id) DO UPDATE SET level=EXCLUDED.level,version=autopilot_policies.version+1,updated_at=NOW()
     RETURNING level,channels,max_budget,currency,version,updated_at`,
    [crypto.randomUUID(), projectId, campaignId, level, req.user.id]
  )
  res.json({ ...rows[0], requiresBoundApproval: level === 3 })
})

export default r
