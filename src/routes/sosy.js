import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { SOSY_IDENTITY } from '../sosy/identity.js'
import { buildSosyDraft, createSosyDelegation, transitionSosyDelegation } from '../sosy/domain.js'
import { getSosyDelegation, listSosyDelegations, saveSosyDelegation, updateSosyDelegation } from '../sosy/store.js'
import { finalizeSosyMediaJob, startSosyMediaJob } from '../sosy/mediaWorkflow.js'
import { getArtifact, saveArtifact } from '../marketing/artifacts.js'
import { saveComposerArtifact } from '../mediaEngine/genome/artifactCreation.js'
import { createJob, transitionJob } from '../jobs/jobStore.js'
import { recordProjectActivity } from '../lib/projectActivity.js'
import { generateVariantCopy } from '../marketing/contentGenerator.js'
import { loadBrandContext } from '../marketing/profileStore.js'
import { assertDefaultVideoExecutionAvailable } from '../mediaEngine/providers/videoExecutionPolicy.js'
import { prepareVendoredComposerProject } from '../mediaEngine/composer/runtime.js'

const runnableStatuses = new Set(['assigned', 'planned', 'queued'])

function sendError(res, error) {
  if (sendProjectError(res, error)) return
  const clientCodes = new Set(['INVALID_TASK_TYPE', 'INVALID_OBJECTIVE', 'INVALID_CHANNELS', 'INVALID_LANGUAGES', 'INVALID_MEDIA_REQUEST', 'SOURCE_ARTIFACT_REQUIRED', 'INVALID_STATUS_TRANSITION'])
  const status = Number.isInteger(error?.status) ? error.status : clientCodes.has(error?.code) ? 400 : 500
  if (status >= 500) console.error('Sosy operation failed', { code: error?.code || 'UNKNOWN' })
  res.status(status).json({ error: status >= 500 ? 'Sosy operation failed' : error.message, code: error?.code || 'SOSY_OPERATION_FAILED' })
}

export function createSosyRouter({ env = process.env, db = pool, mediaJobService, authMiddleware = auth, requireProjectImpl = requireProject, saveArtifactImpl = saveArtifact, saveComposerArtifactImpl = saveComposerArtifact, prepareComposerProjectImpl = prepareVendoredComposerProject, generateVariantCopyImpl = generateVariantCopy, loadBrandContextImpl = loadBrandContext, recordProjectActivityImpl = recordProjectActivity } = {}) {
  const router = Router()
  router.use(authMiddleware)
  router.get('/identity', (_req, res) => res.json({ identity: SOSY_IDENTITY }))
  router.get('/:projectId/delegations', async (req, res) => {
    try {
      await requireProjectImpl(req, req.params.projectId)
      res.json({ delegations: await listSosyDelegations({ userId: req.user.id, projectId: req.params.projectId, tonyPlanId: req.query.tonyPlanId, limit: req.query.limit, db }) })
    } catch (error) { sendError(res, error) }
  })
  router.post('/:projectId/delegations', async (req, res) => {
    try {
      const projectId = req.params.projectId
      await requireProjectImpl(req, projectId)
      const input = req.body || {}
      if (input.tonyPlanId) {
        const owned = await db.query('SELECT id FROM tony_execution_plans WHERE id=$1 AND user_id=$2 AND project_id=$3', [input.tonyPlanId, req.user.id, projectId])
        if (!owned.rows[0]) return res.status(404).json({ error: 'Tony plan not found', code: 'TONY_PLAN_NOT_FOUND' })
      }
      if (input.campaignId) {
        const owned = await db.query('SELECT id FROM marketing_campaigns WHERE id=$1 AND user_id=$2 AND project_id=$3', [input.campaignId, req.user.id, projectId])
        if (!owned.rows[0]) return res.status(404).json({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' })
      }
      if (input.sourceArtifactId && !await getArtifact({ id: input.sourceArtifactId, userId: req.user.id, projectId, db })) return res.status(404).json({ error: 'Source artifact not found', code: 'SOURCE_ARTIFACT_NOT_FOUND' })
      const delegation = await saveSosyDelegation(createSosyDelegation({ ...input, userId: req.user.id, projectId }), db)
      await recordProjectActivityImpl({ userId: req.user.id, projectId, eventType: 'sosy_delegation_created', subjectType: 'sosy_delegation', subjectId: delegation.id, summary: 'Sosy received a draft social task', metadata: { taskType: delegation.taskType, channels: delegation.channels, languages: delegation.languages, visual: Boolean(delegation.mediaRequest), tonyPlanId: delegation.tonyPlanId }, dedupeKey: `sosy:created:${delegation.id}`, db })
      res.status(201).json({ delegation })
    } catch (error) { sendError(res, error) }
  })
  router.post('/:projectId/delegations/:id/run', async (req, res) => {
    const { projectId, id } = req.params
    let working = null
    try {
      await requireProjectImpl(req, projectId)
      const current = await getSosyDelegation({ id, userId: req.user.id, projectId, db })
      if (!current) return res.status(404).json({ error: 'Sosy delegation not found', code: 'SOSY_DELEGATION_NOT_FOUND' })
      if (!runnableStatuses.has(current.status)) return res.status(409).json({ error: 'Sosy delegation is not runnable', code: 'INVALID_STATUS_TRANSITION' })
      if (current.mediaRequest) {
        if (env.MEDIA_JOB_STORE !== 'postgres') throw Object.assign(new Error('Sosy visual work requires the durable media job store'), { code: 'SOSY_MEDIA_DURABLE_STORE_REQUIRED', status: 503 })
        assertDefaultVideoExecutionAvailable({ env, input: current.mediaRequest })
      }
      working = transitionSosyDelegation(current, 'working')
      if (!await updateSosyDelegation({ delegation: working, from: current.status, db })) return res.status(409).json({ error: 'Sosy delegation state changed', code: 'DELEGATION_CONFLICT' })
      if (current.mediaRequest) {
        const result = await startSosyMediaJob({ delegation: working, mediaJobService, idempotencyKey: req.get('Idempotency-Key') || `sosy-media:${id}` })
        const delegation = await updateSosyDelegation({ delegation: { ...working, mediaJobId: result.job.id }, from: 'working', db })
        if (!delegation) return res.status(409).json({ error: 'Sosy delegation state changed', code: 'DELEGATION_CONFLICT' })
        return res.status(result.created ? 202 : 200).json({ delegation, mediaJob: result.job, replayed: !result.created, requiresApproval: true })
      }
      const sourceArtifact = current.sourceArtifactId ? await getArtifact({ id: current.sourceArtifactId, userId: req.user.id, projectId, db }) : null
      const draft = buildSosyDraft(current, { sourceArtifact })
      let provider = 'deterministic-local', model = 'sosy-draft-v1', usage = { providerCalls: 0, mode: 'offline-draft' }
      const variants = draft.content.variants || draft.content.entries
      if (Array.isArray(variants) && variants.length) {
        const generated = await generateVariantCopyImpl({ variants, objective: current.objective, languages: current.languages, brand: await loadBrandContextImpl({ userId: req.user.id, projectId, db }), sourceText: sourceArtifact?.content?.socialCopy || sourceArtifact?.content?.caption || sourceArtifact?.content?.body || null })
        if (generated) {
          if (draft.content.variants) draft.content.variants = generated.variants
          else draft.content.entries = generated.variants.map((variant, index) => ({ ...variant, slot: index + 1 }))
          provider = generated.provider; model = generated.model; usage = generated.usage
        }
      }
      const job = await createJob({ userId: req.user.id, projectId, kind: 'marketing.social', provider, model, idempotencyKey: req.get('Idempotency-Key') || `sosy:${id}`, input: { delegationId: id, taskType: current.taskType } }, db)
      const activeJob = job.status === 'queued' ? await transitionJob({ id: job.id, userId: req.user.id, projectId, from: 'queued', to: 'running', db }) : job
      const artifact = await saveArtifactImpl({ userId: req.user.id, projectId, campaignId: current.campaignId, type: draft.artifactType, purpose: draft.purpose, channel: draft.channel, content: draft.content, provenance: { jobId: job.id }, provider, model }, db)
      await transitionJob({ id: job.id, userId: req.user.id, projectId, from: activeJob.status, to: 'succeeded', artifacts: [{ id: artifact.id, type: artifact.type }], usage, db })
      const delegation = await updateSosyDelegation({ delegation: transitionSosyDelegation(working, 'waiting_approval', { resultArtifactId: artifact.id }), from: 'working', db })
      await recordProjectActivityImpl({ userId: req.user.id, projectId, eventType: 'sosy_draft_completed', subjectType: 'marketing_artifact', subjectId: artifact.id, summary: 'Sosy created a draft awaiting approval', metadata: { delegationId: id, taskType: current.taskType, provider, model }, dedupeKey: `sosy:completed:${id}`, db })
      res.json({ delegation, artifact, job: { ...job, status: 'succeeded' }, mock: provider === 'deterministic-local', requiresApproval: true })
    } catch (error) {
      if (working) { try { await updateSosyDelegation({ delegation: transitionSosyDelegation(working, 'failed', { error }), from: 'working', db }) } catch {} }
      sendError(res, error)
    }
  })
  router.post('/:projectId/delegations/:id/media/finalize', async (req, res) => {
    let current = null
    try {
      const { projectId, id } = req.params
      await requireProjectImpl(req, projectId)
      current = await getSosyDelegation({ id, userId: req.user.id, projectId, db })
      if (!current) return res.status(404).json({ error: 'Sosy delegation not found', code: 'SOSY_DELEGATION_NOT_FOUND' })
      if (current.status !== 'working' || !current.mediaJobId) return res.status(409).json({ error: 'Sosy visual delegation is not awaiting media', code: 'INVALID_STATUS_TRANSITION' })
      const result = await finalizeSosyMediaJob({ delegation: current, mediaJobService, saveArtifact: saveArtifactImpl, saveComposerArtifact: saveComposerArtifactImpl, getArtifact, prepareComposerProject: prepareComposerProjectImpl, db })
      if (!result.ready) return res.status(202).json({ delegation: current, mediaJob: result.job, requiresApproval: true })
      const delegation = await updateSosyDelegation({ delegation: transitionSosyDelegation(current, 'waiting_approval', { resultArtifactId: result.artifact.id }), from: 'working', db })
      if (!delegation) return res.status(409).json({ error: 'Sosy delegation state changed', code: 'DELEGATION_CONFLICT' })
      await recordProjectActivityImpl({ userId: req.user.id, projectId, eventType: 'sosy_draft_completed', subjectType: 'marketing_artifact', subjectId: result.artifact.id, summary: 'Sosy created a visual draft awaiting approval', metadata: { delegationId: id, taskType: current.taskType, provider: result.job.provider, model: result.job.model, visual: true }, dedupeKey: `sosy:completed:${id}`, db })
      res.json({ delegation, artifact: result.artifact, mediaJob: result.job, requiresApproval: true })
    } catch (error) {
      if (current?.status === 'working' && error?.code === 'MEDIA_JOB_FAILED') {
        try { await updateSosyDelegation({ delegation: transitionSosyDelegation(current, 'failed', { error }), from: 'working', db }) } catch {}
      }
      sendError(res, error)
    }
  })
  return router
}

export default createSosyRouter()
