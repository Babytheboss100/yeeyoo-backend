import { pathToFileURL } from 'node:url'
import { startVideoLeaseRunnerFromEnv } from './jobs/videoLeaseBootstrap.js'

export async function startStandaloneVideoRunner({ env = process.env, db, dependencies, scheduleImpl, logger = console } = {}) {
  let ownedPool = null
  if (!db) {
    const database = await import('../db.js')
    ownedPool = database.pool
    db = ownedPool
  }
  const handle = await startVideoLeaseRunnerFromEnv({ env, db, dependencies, scheduleImpl, logger, runtimeMode: 'standalone' })
  if (!handle) {
    if (ownedPool) await ownedPool.end()
    throw new TypeError('Standalone video runner requires MEDIA_VIDEO_RUNNER_MODE=standalone')
  }
  let closing = null
  const stop = () => {
    if (!closing) closing = (async () => {
      await handle.stop()
      if (ownedPool) await ownedPool.end()
    })()
    return closing
  }
  return Object.freeze({ ...handle, stop })
}

async function main() {
  const handle = await startStandaloneVideoRunner()
  const shutdown = async signal => {
    try {
      await handle.stop()
      process.exitCode = 0
    } catch (error) {
      console.error('[video-lease-runner] shutdown failed', { signal, code: error?.code || error?.name || 'ERROR' })
      process.exitCode = 1
    }
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  console.log('[video-lease-runner] started', { workerId: handle.workerId, mode: handle.runtimeMode })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[video-lease-runner] startup failed', { code: error?.code || error?.name || 'ERROR' })
    process.exitCode = 1
  })
}
