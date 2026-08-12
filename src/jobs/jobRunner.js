import { JobError } from './jobModel.js'
import { transitionJob } from './jobStore.js'

const terminalResult = (result = {}) => ({
  artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
  usage: result.usage && typeof result.usage === 'object' ? result.usage : {},
})

export async function runJob({ job, provider, db, timeout = setTimeout, clear = clearTimeout }) {
  if (!job || job.status !== 'queued') throw new JobError('INVALID_JOB_STATE', 'Only queued jobs can run')
  if (!provider?.submit) throw new JobError('INVALID_PROVIDER', 'Job provider is invalid')
  const scope = { id: job.id, userId: job.userId, projectId: job.projectId, db }
  const running = await transitionJob({ ...scope, from: 'queued', to: 'running' })
  if (!running) throw new JobError('JOB_CLAIM_CONFLICT', 'Job was already claimed')
  let timer
  try {
    const expired = new Promise((_, reject) => { timer = timeout(() => reject(new JobError('PROVIDER_TIMEOUT', 'Provider timed out', { retryable: true })), job.timeoutMs) })
    const submitted = await Promise.race([provider.submit(running), expired])
    if (submitted?.state !== 'succeeded') throw new JobError('ASYNC_PROVIDER_RESULT', 'Provider result requires polling', { retryable: true })
    return await transitionJob({ ...scope, from: 'running', to: 'succeeded', providerJobId: submitted.providerJobId, ...terminalResult(submitted.result) })
  } catch (error) {
    return await transitionJob({ ...scope, from: 'running', to: 'failed', error })
  } finally {
    if (timer) clear(timer)
  }
}

export async function retryJob({ job, db }) {
  if (job.status !== 'failed') throw new JobError('INVALID_JOB_STATE', 'Only failed jobs can retry')
  if (job.retryCount >= job.maxRetries) throw new JobError('RETRY_LIMIT', 'Job retry limit reached')
  return transitionJob({ id: job.id, userId: job.userId, projectId: job.projectId, from: 'failed', to: 'queued', db })
}

export async function cancelJob({ job, provider, db }) {
  if (!['queued', 'running'].includes(job.status)) throw new JobError('INVALID_JOB_STATE', 'Job cannot be cancelled')
  if (job.status === 'running' && provider?.cancel) await provider.cancel(job)
  return transitionJob({ id: job.id, userId: job.userId, projectId: job.projectId, from: job.status, to: 'cancelled', db })
}
