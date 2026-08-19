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

export function createDefaultMediaJobStore({ env = process.env, postgresPool } = {}) {
  if (env.MEDIA_JOB_STORE !== 'postgres') return createInMemoryMediaJobStore()
  if (!postgresPool || typeof postgresPool.query !== 'function') {
    throw new TypeError('MEDIA_JOB_STORE=postgres requires the injected canonical PostgreSQL pool')
  }
  return createPostgresMediaJobStore({ db: postgresPool })
}

function defaultService(env, postgresPool) {
  if (!postgresPool || typeof postgresPool.query !== 'function') {
    throw new TypeError('The default media service requires the injected canonical PostgreSQL pool for owner-scoped video assets')
  }
  const rootPath = env.MEDIA_LOCAL_STORAGE_ROOT || path.join(os.tmpdir(), 'yeeyoo-media-phase-a')
  const storage = createLocalDiskStorageAdapter({ rootPath })
  const providers = {
    [IMAGE_OPERATION]: createFakeImageProvider(),
  }
  // Composer execution is intentionally process-local. A PostgreSQL JobStore
  // does not make its status/cancellation state durable or cross-instance safe.
  if (env.MEDIA_JOB_STORE !== 'postgres') {
    providers[VIDEO_RENDER_OPERATION] = createComposerVideoProvider({ storage })
  }
  return createMediaJobService({
    store: createDefaultMediaJobStore({ env, postgresPool }),
    providers,
    storage,
    resolveVideoInput: createArtifactVideoInputResolver({ db: postgresPool }),
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

export function createMediaJobsRouter({ env = process.env, postgresPool, service = defaultService(env, postgresPool), authMiddleware = auth, requireProjectImpl = requireProject, createLimiter = aiLimiter } = {}) {
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

  router.get('/:id', async (req, res) => {
    try {
      const owned = await service.getJob({ id: req.params.id, userId: req.user.id })
      if (!owned) throw new MediaJobError('MEDIA_JOB_NOT_FOUND', 'Media job not found', { status: 404 })
      await requireProjectImpl(req, owned.projectId)
      const job = await service.refresh({ id: owned.id, userId: req.user.id })
      res.json({ job, ...executionDisclosure(job) })
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
