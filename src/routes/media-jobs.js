import os from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { aiLimiter } from '../middleware/security.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { createFakeImageProvider } from '../mediaEngine/providers/fakeProvider.js'
import { createComposerVideoProvider, VIDEO_RENDER_OPERATION } from '../mediaEngine/providers/composerVideo.js'
import { IMAGE_OPERATION } from '../mediaEngine/contracts/workerApi.js'
import { createInMemoryMediaJobStore } from '../mediaEngine/jobs/memoryJobStore.js'
import { createPostgresMediaJobStore } from '../mediaEngine/jobs/postgresJobStore.js'
import { createMediaJobService } from '../mediaEngine/jobs/jobService.js'
import { MediaJobError, toSafeMediaJobError } from '../mediaEngine/jobs/errors.js'
import { createLocalDiskStorageAdapter } from '../mediaEngine/storage/localDiskFake.js'
import { createArtifactVideoInputResolver } from '../mediaEngine/genome/videoInputResolver.js'
import { assertDefaultVideoExecutionAvailable } from '../mediaEngine/providers/videoExecutionPolicy.js'
import { getArtifact, saveArtifact } from '../marketing/artifacts.js'
import { saveComposerArtifact } from '../mediaEngine/genome/artifactCreation.js'
import { prepareMediaJobArtifact } from '../mediaEngine/genome/jobArtifact.js'
import { prepareVendoredComposerProject } from '../mediaEngine/composer/runtime.js'
import { getApprovedMediaAsset } from '../mediaEngine/genome/assetPreview.js'
import { canonicalStringify } from '../mediaEngine/contracts/workerApi.js'

export function createDefaultMediaJobStore({ env = process.env, postgresPool } = {}) {
  if (env.MEDIA_JOB_STORE !== 'postgres') return createInMemoryMediaJobStore()
  if (!postgresPool || typeof postgresPool.query !== 'function') {
    throw new TypeError('MEDIA_JOB_STORE=postgres requires the injected canonical PostgreSQL pool')
  }
  return createPostgresMediaJobStore({ db: postgresPool })
}

export function createDefaultMediaJobService({ env = process.env, postgresPool } = {}) {
  if (!postgresPool || typeof postgresPool.query !== 'function') {
    throw new TypeError('The default media service requires the injected canonical PostgreSQL pool for owner-scoped video assets')
  }
  const rootPath = env.MEDIA_LOCAL_STORAGE_ROOT || path.join(os.tmpdir(), 'yeeyoo-media-phase-a')
  const storage = createLocalDiskStorageAdapter({ rootPath })
  const providers = {
    [IMAGE_OPERATION]: createFakeImageProvider(),
    [VIDEO_RENDER_OPERATION]: createComposerVideoProvider({ storage }),
  }
  return createMediaJobService({
    store: createDefaultMediaJobStore({ env, postgresPool }),
    providers,
    storage,
    resolveVideoInput: createArtifactVideoInputResolver({ db: postgresPool }),
    deferredOperations: env.MEDIA_JOB_STORE === 'postgres' ? [VIDEO_RENDER_OPERATION] : [],
  })
}

function executionDisclosure(job) {
  const composer = job?.provider === 'composer-video'
  return { providerActionTaken: composer, mock: !composer }
}

function sendError(res, error) {
  if (sendProjectError(res, error)) return
  const safe = toSafeMediaJobError(error)
  if (safe.status >= 500) console.error('[media-jobs] operation failed', { code: safe.code })
  res.status(safe.status).json({ error: safe.message, code: safe.code })
}

export function createMediaJobsRouter({ env = process.env, postgresPool, service = createDefaultMediaJobService({ env, postgresPool }), authMiddleware = auth, requireProjectImpl = requireProject, createLimiter = aiLimiter, saveArtifactImpl = saveArtifact, saveComposerArtifactImpl = saveComposerArtifact } = {}) {
  const router = Router()
  router.use(authMiddleware)
  router.use((req, res, next) => env.MEDIA_ENGINE_PHASE_A_ENABLED === 'true'
    ? next()
    : res.status(503).json({ error: 'Media Engine Phase A is disabled', code: 'MEDIA_ENGINE_PHASE_A_DISABLED' }))

  router.post('/', createLimiter, async (req, res) => {
    try {
      assertDefaultVideoExecutionAvailable({ env, input: req.body })
      const projectId = req.body?.projectId
      await requireProjectImpl(req, projectId)
      const result = await service.create({ userId: req.user.id, input: req.body, idempotencyKey: req.get('Idempotency-Key') })
      res.status(result.created ? 202 : 200).json({ job: result.job, replayed: !result.created, ...executionDisclosure(result.job) })
    } catch (error) { sendError(res, error) }
  })

  router.get('/assets/:artifactId/preview', async (req, res) => {
    try {
      const projectId = req.query?.projectId
      await requireProjectImpl(req, projectId)
      const asset = await getApprovedMediaAsset({ db: postgresPool, userId: req.user.id, projectId, artifactId: req.params.artifactId })
      res.json(await service.getStoredPreview(asset))
    } catch (error) { sendError(res, error) }
  })

  router.get('/:id', async (req, res) => {
    try {
      const owned = await service.getJob({ id: req.params.id, userId: req.user.id })
      if (!owned) throw new MediaJobError('MEDIA_JOB_NOT_FOUND', 'Media job not found', { status: 404 })
      await requireProjectImpl(req, owned.projectId)
      const job = await service.refresh({ id: owned.id, userId: req.user.id })
      res.json({ job, ...executionDisclosure(job) })
    } catch (error) { sendError(res, error) }
  })

  router.get('/:id/preview', async (req, res) => {
    try {
      const owned = await service.getJob({ id: req.params.id, userId: req.user.id })
      if (!owned) throw new MediaJobError('MEDIA_JOB_NOT_FOUND', 'Media job not found', { status: 404 })
      await requireProjectImpl(req, owned.projectId)
      if (typeof service.getPreview !== 'function') throw new MediaJobError('MEDIA_PREVIEW_SETUP_REQUIRED', 'Media preview is not configured', { status: 503 })
      res.json(await service.getPreview({ id: owned.id, userId: req.user.id }))
    } catch (error) { sendError(res, error) }
  })

  router.post('/:id/artifact', async (req, res) => {
    try {
      const job = await service.getJob({ id: req.params.id, userId: req.user.id })
      if (!job) throw new MediaJobError('MEDIA_JOB_NOT_FOUND', 'Media job not found', { status: 404 })
      await requireProjectImpl(req, job.projectId)
      if (job.status !== 'succeeded' || !job.artifacts?.[0]) throw new MediaJobError('MEDIA_RESULT_NOT_READY', 'Media result is not ready', { status: 409 })
      const prepared = prepareMediaJobArtifact({ job, body: req.body, userId: req.user.id, composerProjectSha256: job.artifacts[0].composerProjectSha256 || null })
      let composer = null
      if (job.operation === VIDEO_RENDER_OPERATION) {
        try { composer = prepareVendoredComposerProject({ project: prepared.composerProject, hints: prepared.genomeHints }) }
        catch { throw new MediaJobError('COMPOSER_PROJECT_INVALID', 'Composer project is invalid', { status: 400 }) }
        if (composer.projectSha256 !== job.artifacts[0].composerProjectSha256) throw new MediaJobError('COMPOSER_PROJECT_CHECKSUM_MISMATCH', 'Composer project does not match the rendered media', { status: 409 })
      }
      let artifact = await getArtifact({ id: job.id, userId: req.user.id, projectId: job.projectId, db: postgresPool })
      let replayed = Boolean(artifact)
      if (artifact && (artifact.provenance?.jobId !== job.id || artifact.outputChecksum !== job.artifacts[0].sha256 || artifact.purpose !== prepared.artifactInput.purpose || artifact.channel !== prepared.artifactInput.channel || canonicalStringify(artifact.content) !== canonicalStringify(prepared.artifactInput.content) || (composer && canonicalStringify(artifact.genome ?? null) !== canonicalStringify(composer.genome)))) throw new MediaJobError('MEDIA_ARTIFACT_CONFLICT', 'Media job artifact binding conflicts with existing content', { status: 409 })
      if (artifact && artifact.status !== 'draft') throw new MediaJobError('MEDIA_ARTIFACT_ALREADY_REVIEWED', 'Media job artifact has already entered review', { status: 409 })
      if (!artifact) {
        try {
          artifact = job.operation === VIDEO_RENDER_OPERATION
            ? await saveComposerArtifactImpl({ ...prepared.artifactInput, artifactId: job.id, composerProject: composer.project, genomeHints: prepared.genomeHints }, postgresPool)
            : await saveArtifactImpl(prepared.artifactInput, postgresPool, { id: job.id })
        } catch (error) {
          if (error?.code !== '23505') throw error
          artifact = await getArtifact({ id: job.id, userId: req.user.id, projectId: job.projectId, db: postgresPool })
          if (!artifact || artifact.provenance?.jobId !== job.id || artifact.outputChecksum !== job.artifacts[0].sha256 || artifact.status !== 'draft' || artifact.purpose !== prepared.artifactInput.purpose || artifact.channel !== prepared.artifactInput.channel || canonicalStringify(artifact.content) !== canonicalStringify(prepared.artifactInput.content) || (composer && canonicalStringify(artifact.genome ?? null) !== canonicalStringify(composer.genome))) throw error
          replayed = true
        }
      }
      res.status(replayed ? 200 : 201).json({ artifact, requiresApproval: true, replayed })
    } catch (error) { sendError(res, error) }
  })

  router.post('/:id/cancel', async (req, res) => {
    try {
      const owned = await service.getJob({ id: req.params.id, userId: req.user.id })
      if (!owned) throw new MediaJobError('MEDIA_JOB_NOT_FOUND', 'Media job not found', { status: 404 })
      await requireProjectImpl(req, owned.projectId)
      const job = await service.cancel({ id: owned.id, userId: req.user.id })
      res.json({ job, ...executionDisclosure(job) })
    } catch (error) { sendError(res, error) }
  })

  return router
}

export default createMediaJobsRouter
