import { recordAIUsage } from '../services/aiUsageLedger.js'

const nonNegativeInteger = value => {
  const number = Number(value ?? 0)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

const providerIdentity = job => {
  if (job.provider === 'deterministic-local') {
    return { provider: 'local', model: 'deterministic-fixture-v1' }
  }
  const canonical = { claude:'anthropic', 'gpt-4o':'openai', gemini:'google', grok:'xai', deepseek:'deepseek' }
  return { provider: canonical[job.provider] || job.provider, model: job.model }
}

// One terminal usage event per durable job attempt. The job id is the logical
// request key; the retry counter distinguishes actual provider attempts while
// the ledger's unique constraint makes worker replay harmless.
export async function recordCompletedJobUsage({ job, usage = job?.usage || {}, recorder = recordAIUsage, db } = {}) {
  if (!job?.id || !job.userId || !job.projectId) throw new TypeError('A scoped durable job is required')
  const { provider, model } = providerIdentity(job)
  if (!provider || !model) throw new TypeError('Job provider and model are required for usage accounting')
  return recorder({
    userId: job.userId,
    projectId: job.projectId,
    jobId: job.id,
    operation: job.kind,
    provider,
    model,
    idempotencyKey: job.id,
    attempt: nonNegativeInteger(job.retryCount) + 1,
    status: 'succeeded',
    inputTokens: nonNegativeInteger(usage.tokensIn ?? usage.inputTokens),
    outputTokens: nonNegativeInteger(usage.tokensOut ?? usage.outputTokens),
    cachedInputTokens: nonNegativeInteger(usage.cachedInputTokens),
    billable: provider !== 'local',
    metadata: { source: 'durable-job', mode: usage.mode || null, providerCalls: nonNegativeInteger(usage.providerCalls) },
  }, { db })
}
