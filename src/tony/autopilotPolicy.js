import crypto from 'node:crypto'

export const AUTOPILOT_LEVEL = Object.freeze({ MANUAL: 0, DRAFT: 1, PLAN: 2, APPROVED: 3 })
const MIN_LEVEL = Object.freeze({ recommend: 0, create_draft: 1, create_plan: 2, publish: 3, send: 3 })
const NEVER = new Set(['spend', 'increase_budget', 'connect', 'disconnect', 'delete', 'change_security'])

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function approvalFingerprint({ action, userId, projectId, campaignId, planId, artifactId, artifactVersion, budget, currency, channels, policyVersion, providerConnectionId, providerConnectionVersion }) {
  return digest({ action, userId, projectId, campaignId, planId: planId || null, artifactId, artifactVersion,
    budget, currency, channels: [...(channels || [])].sort(), policyVersion, providerConnectionId, providerConnectionVersion })
}

function fingerprintsEqual(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

// pg returns snake_case persistence rows. Normalize once at the policy boundary
// so consumed/revoked approvals can never be accidentally treated as fresh.
export function normalizePersistedApproval(value) {
  if (!value || typeof value !== 'object') return null
  return Object.freeze({
    status: value.status || (value.revoked_at ? 'revoked' : 'approved'),
    action: value.action, userId: value.userId ?? value.user_id, projectId: value.projectId ?? value.project_id, campaignId: value.campaignId ?? value.campaign_id,
    approvedByUserId: value.approvedByUserId ?? value.approved_by_user_id, approvedAt: value.approvedAt ?? value.approved_at,
    expiresAt: value.expiresAt ?? value.expires_at, revokedAt: value.revokedAt ?? value.revoked_at,
    usedAt: value.usedAt ?? value.consumedAt ?? value.consumed_at, nonce: value.nonce, fingerprint: value.fingerprint,
  })
}

export function authorizeAutopilot({ policy, action, context, approval = null, now = Date.now() }) {
  const deny = (code) => Object.freeze({ allowed: false, code, audit: { action, projectId: context?.projectId || null, campaignId: context?.campaignId || null, at: new Date(now).toISOString() } })
  if (!policy || !context?.userId || !context?.projectId || !context?.campaignId) return deny('CONTEXT_REQUIRED')
  if (policy.projectId !== context.projectId || policy.campaignId !== context.campaignId) return deny('POLICY_BOUNDARY_MISMATCH')
  if (NEVER.has(action)) return deny('ACTION_NEVER_AUTONOMOUS')
  if (!(action in MIN_LEVEL)) return deny('UNKNOWN_ACTION')
  if (!Number.isInteger(policy.level) || policy.level < MIN_LEVEL[action] || policy.level > 3) return deny('AUTOPILOT_LEVEL_DENIED')
  if (action === 'publish' || action === 'send') {
    approval = normalizePersistedApproval(approval)
    if (!approval || approval.status !== 'approved' || approval.revokedAt) return deny('VALID_APPROVAL_REQUIRED')
    if (!approval.approvedByUserId || !approval.approvedAt) return deny('VALID_APPROVAL_REQUIRED')
    if (approval.action !== action || approval.userId !== context.userId || approval.projectId !== context.projectId || approval.campaignId !== context.campaignId) return deny('APPROVAL_SCOPE_MISMATCH')
    const expiresAt = Date.parse(approval.expiresAt)
    const approvedAt = Date.parse(approval.approvedAt)
    if (!Number.isFinite(expiresAt) || !Number.isFinite(approvedAt) || approvedAt > now || expiresAt <= approvedAt || expiresAt <= now) return deny('APPROVAL_EXPIRED')
    if (approval.usedAt || approval.nonce !== context.approvalNonce) return deny('APPROVAL_REPLAY_DENIED')
    if (!context.providerConnected) return deny('PROVIDER_CONNECTION_REVOKED')
    const channels = context.channels || []
    if (!channels.length || channels.some(channel => !policy.channels?.includes(channel))) return deny('CHANNEL_BOUNDARY_DENIED')
    const requestedBudget = Number(context.budget)
    const maximumBudget = Number(policy.maxBudget)
    if (!Number.isFinite(requestedBudget) || requestedBudget < 0 || !Number.isFinite(maximumBudget) || requestedBudget > maximumBudget || context.currency !== policy.currency) return deny('BUDGET_BOUNDARY_DENIED')
    const expected = approvalFingerprint({ ...context, action, policyVersion: policy.version })
    if (!fingerprintsEqual(approval.fingerprint, expected)) return deny('APPROVED_STATE_CHANGED')
  }
  return Object.freeze({ allowed: true, code: 'AUTHORIZED', audit: { action, projectId: context.projectId, campaignId: context.campaignId, policyLevel: policy.level, at: new Date(now).toISOString() } })
}
