import crypto from 'node:crypto'
import { createJob } from './jobStore.js'
import { getJobPolicy, normalizeArtifacts } from './jobKinds.js'

// Transitional boundary: routes keep their legacy response/storage contract while
// also creating one canonical durable job. The caller controls its transaction.
export async function beginDurableJob({ userId, projectId, kind, provider, model, input, idempotencyKey, db }) {
  if (!projectId) throw new TypeError('projectId is required for durable AI work')
  const policy = getJobPolicy(kind)
  return createJob({ userId, projectId, kind, provider, model, input, idempotencyKey: idempotencyKey || crypto.randomUUID(), ...policy }, db)
}

export function durableResult(kind, result, usage = {}) {
  return { artifacts: normalizeArtifacts(kind, result), usage }
}
