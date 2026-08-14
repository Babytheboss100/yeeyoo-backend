import { claimNextJob, completeClaimedJob, failClaimedJob, recoverExpiredJobs } from './workerStore.js'
import { recordCompletedJobUsage } from './jobUsage.js'

export function createWorker({ workerId, handlers, db, leaseSeconds = 90, usageRecorder }) {
  if (!workerId || !handlers || !Object.keys(handlers).length) throw new TypeError('workerId and handlers are required')
  return Object.freeze({
    async recover() { return recoverExpiredJobs({ db }) },
    async runOnce() {
      const job = await claimNextJob({ workerId, kinds: Object.keys(handlers), leaseSeconds, db })
      if (!job) return null
      try {
        const result = await handlers[job.kind](job)
        const completed = await completeClaimedJob({ id: job.id, workerId, artifacts: result?.artifacts, usage: result?.usage, db })
        if (completed) await recordCompletedJobUsage({ job: completed, usage: result?.usage, recorder: usageRecorder, db })
          .catch(error => console.error('[ai-usage] worker completion was not recorded:', error.code || error.name))
        return { job: completed, result }
      } catch (error) {
        const failed = await failClaimedJob({ id: job.id, workerId, error, retryable: error?.retryable !== false, db })
        return { job: failed, error }
      }
    },
  })
}
