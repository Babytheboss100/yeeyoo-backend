import crypto from 'node:crypto'

export const AUTOPILOT_LEVEL = Object.freeze({ MANUAL: 0, DRAFT: 1, PLAN: 2, APPROVED: 3 })
const MIN_LEVEL = Object.freeze({ recommend: 0, create_draft: 1, create_plan: 2, publish: 3, send: 3 })
const NEVER = new Set(['spend', 'increase_budget', 'connect', 'disconnect', 'delete', 'change_security'])

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function approvalFingerprint({ projectId, campaignId, artifactId, artifactVersion, budget, currency, channels }) {
  return digest({ projectId, campaignId, artifactId, artifactVersion, budget, currency, channels: [...(channels || [])].sort() })
}

export function authorizeAutopilot({ policy, action, context, approval = null, now = Date.now() }) {
  const deny = (code) => Object.freeze({ allowed: false, code, audit: { action, projectId: context?.projectId || null, campaignId: context?.campaignId || null, at: new Date(now).toISOString() } })
  if (!policy || !context?.userId || !context?.projectId || !context?.campaignId) return deny('CONTEXT_REQUIRED')
  if (policy.projectId !== context.projectId || policy.campaignId !== context.campaignId) return deny('POLICY_BOUNDARY_MISMATCH')
  if (NEVER.has(action)) return deny('ACTION_NEVER_AUTONOMOUS')
  if (!(action in MIN_LEVEL)) return deny('UNKNOWN_ACTION')
  if (!Number.isInteger(policy.level) || policy.level < MIN_LEVEL[action] || policy.level > 3) return deny('AUTOPILOT_LEVEL_DENIED')
  if (action === 'publish' || action === 'send') {
    if (!approval || approval.status !== 'approved' || approval.revokedAt) return deny('VALID_APPROVAL_REQUIRED')
    if (!approval.expiresAt || Date.parse(approval.expiresAt) <= now) return deny('APPROVAL_EXPIRED')
    if (approval.usedAt || approval.nonce !== context.approvalNonce) return deny('APPROVAL_REPLAY_DENIED')
    if (!context.providerConnected) return deny('PROVIDER_CONNECTION_REVOKED')
    const channels = context.channels || []
    if (!channels.length || channels.some(channel => !policy.channels?.includes(channel))) return deny('CHANNEL_BOUNDARY_DENIED')
    const requestedBudget = Number(context.budget)
    const maximumBudget = Number(policy.maxBudget)
    if (!Number.isFinite(requestedBudget) || requestedBudget < 0 || !Number.isFinite(maximumBudget) || requestedBudget > maximumBudget || context.currency !== policy.currency) return deny('BUDGET_BOUNDARY_DENIED')
    const expected = approvalFingerprint(context)
    if (approval.fingerprint !== expected) return deny('APPROVED_STATE_CHANGED')
  }
  return Object.freeze({ allowed: true, code: 'AUTHORIZED', audit: { action, projectId: context.projectId, campaignId: context.campaignId, policyLevel: policy.level, at: new Date(now).toISOString() } })
}
