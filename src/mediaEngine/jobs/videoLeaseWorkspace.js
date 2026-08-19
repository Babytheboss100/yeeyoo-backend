import path from 'node:path'
import { lstat, mkdir, rm } from 'node:fs/promises'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createVideoLeaseWorkspace({ rootPath } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath === path.parse(rootPath).root) throw new TypeError('Video lease workspace root is invalid')
  async function verifiedRoot() {
    await mkdir(rootPath, { recursive: true, mode: 0o700 })
    const stat = await lstat(rootPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Video lease workspace root is unsafe')
  }
  function jobPath(jobId) {
    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) throw new TypeError('Video lease workspace job id is invalid')
    return path.join(rootPath, jobId.toLowerCase())
  }
  return Object.freeze({
    async prepare(jobId) {
      await verifiedRoot()
      const target = jobPath(jobId)
      await rm(target, { recursive: true, force: true })
      await mkdir(target, { recursive: false, mode: 0o700 })
      return target
    },
    async cleanup(jobId) {
      await verifiedRoot()
      await rm(jobPath(jobId), { recursive: true, force: true })
    },
  })
}
