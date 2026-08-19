import crypto from 'node:crypto'

const SHA256_RE = /^[a-f0-9]{64}$/

function requireText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) throw new TypeError(`${name} is invalid`)
  return value
}

function requireSha256(value, name) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${name} is invalid`)
  return value
}

export function createRenderApprovalBinding(input, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  const artifactVersion = input?.artifactVersion
  if (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1) throw new TypeError('artifactVersion is invalid')
  return Object.freeze({
    id: requireText(id, 'id'),
    userId: requireText(input?.userId, 'userId'),
    projectId: requireText(input?.projectId, 'projectId'),
    artifactId: requireText(input?.artifactId, 'artifactId'),
    artifactVersion,
    outputSha256: requireSha256(input?.outputSha256, 'outputSha256'),
    composerProjectSha256: requireSha256(input?.composerProjectSha256, 'composerProjectSha256'),
    approvedAt: requireText(now, 'approvedAt'),
    revokedAt: null,
    revocationReason: null,
  })
}

export function revokeRenderApproval(binding, { now = new Date().toISOString(), reason } = {}) {
  if (!binding || binding.revokedAt) return binding
  return Object.freeze({ ...structuredClone(binding), revokedAt: requireText(now, 'revokedAt'), revocationReason: requireText(reason, 'reason', 500) })
}

export function assertRenderApproval(binding, artifact) {
  const media = artifact?.content?.media
  if (!binding || binding.revokedAt || binding.userId !== artifact?.userId || binding.projectId !== artifact?.projectId ||
      binding.artifactId !== artifact?.id || binding.artifactVersion !== artifact?.artifactVersion ||
      binding.outputSha256 !== media?.sha256 || binding.composerProjectSha256 !== media?.composerProjectSha256) {
    const error = new Error('Approval does not match the immutable render artifact')
    error.code = binding?.revokedAt ? 'APPROVAL_REVOKED' : 'STALE_OR_FORGED_APPROVAL'
    throw error
  }
  return true
}

