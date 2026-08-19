import os from 'node:os'
import path from 'node:path'
import { createPostgresVideoLeaseStore } from './postgresVideoLeaseStore.js'
import { createVideoLeaseRunner } from './videoLeaseRunner.js'

function positiveInt(value, fallback, { min, max, name }) {
  const parsed = value == null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new TypeError(`${name} is invalid`)
  return parsed
}

function requestedMode(env) {
  const explicit = env.MEDIA_VIDEO_RUNNER_MODE
  if (explicit != null && !['disabled', 'embedded', 'standalone'].includes(explicit)) throw new TypeError('MEDIA_VIDEO_RUNNER_MODE is invalid')
  if (explicit) return explicit
  return env.MEDIA_VIDEO_LEASE_RUNNER_ENABLED === 'true' ? 'embedded' : 'disabled'
}

function cronExpression(value) {
  const expression = value || '*/1 * * * * *'
  if (typeof expression !== 'string' || expression !== expression.trim() || !expression || expression.length > 100 || /[\u0000-\u001f\u007f]/.test(expression)) throw new TypeError('MEDIA_VIDEO_CRON is invalid')
  return expression
}

export async function startVideoLeaseRunnerFromEnv({
  env = process.env, db, dependencies, runtimeMode = 'embedded', scheduleImpl, logger = console,
} = {}) {
  if (!['embedded', 'standalone'].includes(runtimeMode)) throw new TypeError('Video runner runtimeMode is invalid')
  if (requestedMode(env) !== runtimeMode) return null
  if (env.MEDIA_JOB_STORE !== 'postgres') throw new TypeError('Video lease runner requires MEDIA_JOB_STORE=postgres')
  if (!db || typeof db.query !== 'function') throw new TypeError('Enabled video lease runner requires the injected canonical PostgreSQL pool')
  const workerId = env.MEDIA_VIDEO_LEASE_WORKER_ID || `${os.hostname()}-${process.pid}`
  const leaseSeconds = positiveInt(env.MEDIA_VIDEO_LEASE_SECONDS, 90, { min: 5, max: 3600, name: 'MEDIA_VIDEO_LEASE_SECONDS' })
  const heartbeatMs = positiveInt(env.MEDIA_VIDEO_HEARTBEAT_MS, Math.max(100, Math.floor(leaseSeconds * 1000 / 3)), { min: 100, max: leaseSeconds * 1000 - 1, name: 'MEDIA_VIDEO_HEARTBEAT_MS' })
  const scheduleExpression = cronExpression(env.MEDIA_VIDEO_CRON)
  let deps = dependencies
  if (!deps) {
    const [{ createLocalDiskStorageAdapter }, { createArtifactVideoInputResolver }, { executeComposerVideoRender }, { createVideoLeaseWorkspace }] = await Promise.all([
      import('../storage/localDiskFake.js'), import('../genome/videoInputResolver.js'), import('../composer/runtime.js'), import('./videoLeaseWorkspace.js'),
    ])
    const storage = createLocalDiskStorageAdapter({ rootPath: env.MEDIA_LOCAL_STORAGE_ROOT || path.join(os.tmpdir(), 'yeeyoo-media-phase-a') })
    const workspace = createVideoLeaseWorkspace({ rootPath: env.MEDIA_VIDEO_WORKSPACE_ROOT || path.join(os.tmpdir(), 'yeeyoo-media-video-leases') })
    deps = { storage, workspace, resolveVideoInput: createArtifactVideoInputResolver({ db }), execute: executeComposerVideoRender }
  }
  const runner = createVideoLeaseRunner({ workerId, store: createPostgresVideoLeaseStore({ db }), storage: deps.storage, workspace: deps.workspace, resolveVideoInput: deps.resolveVideoInput, execute: deps.execute, leaseSeconds, heartbeatMs })
  let stopped = false
  let busy = false
  const poll = async () => {
    if (stopped || busy) return
    busy = true
    try { await runner.runOnce() } catch (error) { logger.error?.('[video-lease-runner] poll failed', { code: error?.code || error?.name || 'ERROR' }) } finally { busy = false }
  }
  let schedule = scheduleImpl
  if (!schedule) {
    const cron = (await import('node-cron')).default
    if (!cron.validate(scheduleExpression)) throw new TypeError('MEDIA_VIDEO_CRON is invalid')
    schedule = cron.schedule.bind(cron)
  }
  const task = schedule(scheduleExpression, poll, { scheduled: false, name: `video-lease-${runtimeMode}` })
  if (!task || typeof task.start !== 'function' || typeof task.stop !== 'function') throw new TypeError('Video runner cron scheduler is invalid')
  task.start()
  void poll()
  return Object.freeze({ workerId, runtimeMode, runner, async stop() { stopped = true; task.stop(); runner.abortActive(); while (busy) await new Promise(resolve => setTimeout(resolve, 10)) } })
}

export { requestedMode as resolveVideoRunnerMode }
