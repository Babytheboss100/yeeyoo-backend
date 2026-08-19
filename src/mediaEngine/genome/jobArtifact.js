import { IMAGE_OPERATION } from '../contracts/workerApi.js'
import { VIDEO_RENDER_OPERATION } from '../providers/composerVideo.js'
import { MediaJobError } from '../jobs/errors.js'

const HINT_FIELDS = new Set(['narrative', 'hookType', 'ctaType', 'audience', 'language'])

function invalid(code, message, status = 400) { throw new MediaJobError(code, message, { status }) }

export function prepareMediaJobArtifact({ job, body, userId, composerProjectSha256 = null } = {}) {
  if (!job || job.status !== 'succeeded' || !job.artifacts?.[0]) invalid('MEDIA_RESULT_NOT_READY', 'Media result is not ready', 409)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) invalid('INVALID_ARTIFACT_REQUEST', 'Artifact body must be an object')
  if (Object.keys(body).some(key => !['purpose', 'channel', 'composerProject', 'genomeHints'].includes(key))) invalid('INVALID_ARTIFACT_REQUEST', 'Artifact body contains unsupported fields')
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : ''
  const channel = typeof body.channel === 'string' ? body.channel.trim().toLowerCase() : ''
  if (!purpose || purpose.length > 300 || !/^[a-z][a-z0-9_-]{0,63}$/.test(channel)) invalid('INVALID_ARTIFACT_REQUEST', 'Artifact purpose and channel are required')
  const hints = body.genomeHints || {}
  if (!hints || typeof hints !== 'object' || Array.isArray(hints) || Object.getPrototypeOf(hints) !== Object.prototype || Object.keys(hints).some(key => !HINT_FIELDS.has(key)) || Object.values(hints).some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) invalid('INVALID_ARTIFACT_REQUEST', 'Artifact genome hints are invalid')
  if (job.operation === VIDEO_RENDER_OPERATION && (!body.composerProject || typeof body.composerProject !== 'object' || Array.isArray(body.composerProject))) invalid('COMPOSER_PROJECT_REQUIRED', 'Video artifact requires its Composer project')
  if (job.operation === IMAGE_OPERATION && body.composerProject != null) invalid('INVALID_ARTIFACT_REQUEST', 'Image artifact cannot contain a Composer project')
  const output = job.artifacts[0]
  if (job.operation === VIDEO_RENDER_OPERATION) {
    if (composerProjectSha256 !== output.composerProjectSha256) invalid('COMPOSER_PROJECT_CHECKSUM_MISMATCH', 'Composer project does not match the rendered media', 409)
  }
  const artifactInput = {
    userId, projectId: job.projectId, type: 'social', purpose, channel,
    content: { schemaVersion: 1, kind: 'social-visual-draft', media: { kind: job.operation === VIDEO_RENDER_OPERATION ? 'video' : 'image', storage: output.storage, objectRef: output.objectRef, mimeType: output.mimeType, sha256: output.sha256, sizeBytes: output.sizeBytes, ...(output.composerProjectSha256 ? { composerProjectSha256: output.composerProjectSha256 } : {}) } },
    provenance: { jobId: job.id }, provider: job.provider, model: job.model,
  }
  return Object.freeze({ artifactInput, composerProject: job.operation === VIDEO_RENDER_OPERATION ? structuredClone(body.composerProject) : null, genomeHints: structuredClone(hints) })
}
