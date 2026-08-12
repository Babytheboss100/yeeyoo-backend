import crypto from 'node:crypto'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { getMarketingProfile } from '../marketing/profileStore.js'
import { saveArtifact } from '../marketing/artifacts.js'
import { createJob } from '../jobs/jobStore.js'
import { specialistGenerators } from '../marketing/specialistAgents.js'
import { pool } from '../db.js'

const r = Router(); r.use(auth)
const fail = (res,error) => { if (!sendProjectError(res,error)) res.status(400).json({ error:error.message, code:error.code || 'INVALID_REQUEST' }) }

async function contextFor(userId, projectId) {
  const [profile, competitors, connections] = await Promise.all([
    getMarketingProfile({ userId, projectId }),
    pool.query(`SELECT id,evidence,intelligence FROM competitors WHERE user_id=$1 AND project_id=$2 AND status='analyzed'`,[userId,projectId]),
    pool.query(`SELECT provider,status FROM channel_connections WHERE user_id=$1 AND project_id=$2`,[userId,projectId]),
  ])
  return { profile, competitors:competitors.rows.map(row => ({ id:row.id, evidenceIds:(row.evidence || []).map(item => item.id || item.url).filter(Boolean), observations:row.intelligence?.seoObservations || [] })), connections:connections.rows }
}

r.post('/:projectId/:kind', async (req,res) => {
  try {
    const { projectId,kind } = req.params; await requireProject(req,projectId)
    const generate = specialistGenerators[kind]; if (!generate) return res.status(404).json({ error:'Unknown specialist' })
    const context = await contextFor(req.user.id,projectId); const content = generate(req.body || {},context)
    const job = await createJob({ userId:req.user.id,projectId,kind:`marketing.${kind}`,provider:'deterministic-local',model:`${kind}-fixture-v1`,idempotencyKey:req.get('Idempotency-Key') || `${kind}:${crypto.randomUUID()}`,input:req.body || {} })
    const artifact = await saveArtifact({ userId:req.user.id,projectId,campaignId:req.body?.campaignId,type:kind,purpose:req.body?.purpose || content.objective,channel:req.body?.channel || null,content,provenance:{ marketingProfileVersion:context.profile.version,competitorIds:content.provenance.competitorIds,jobId:job.id },provider:'deterministic-local',model:`${kind}-fixture-v1` })
    res.status(201).json({ artifact,jobId:job.id,mock:true,execution:false,note:'Offline draft only; no provider was contacted.' })
  } catch(error) { fail(res,error) }
})

export default r
