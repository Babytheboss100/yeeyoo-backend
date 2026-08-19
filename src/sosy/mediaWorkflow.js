import { canonicalStringify } from '../mediaEngine/contracts/workerApi.js'
export { normalizeSosyMediaRequest } from './mediaRequest.js'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function fail(code, message, status = 400) {
  throw Object.assign(new TypeError(message), { code, status })
}

function mediaInput(delegation) {
  const request = delegation.mediaRequest
  if (!request) fail('MEDIA_REQUEST_REQUIRED', 'Delegation has no visual media request')
  if (request.operation === 'video.render') return { projectId: delegation.projectId, operation: request.operation, project: request.composerProject }
  return { projectId: delegation.projectId, operation: request.operation, prompt: request.prompt, ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}), ...Object.fromEntries(['width', 'height', 'seed', 'steps'].filter(field => request[field] != null).map(field => [field, request[field]])) }
}

export async function startSosyMediaJob({ delegation, mediaJobService, idempotencyKey } = {}) {
  if (!delegation?.mediaRequest || !mediaJobService || typeof mediaJobService.create !== 'function') fail('MEDIA_ENGINE_SETUP_REQUIRED', 'Media Engine is not configured', 503)
  return mediaJobService.create({ userId: delegation.userId, input: mediaInput(delegation), idempotencyKey: idempotencyKey || `sosy-media:${delegation.id}` })
}

export async function finalizeSosyMediaJob({ delegation, mediaJobService, saveArtifact, saveComposerArtifact, getArtifact, prepareComposerProject, db } = {}) {
  if (!delegation?.mediaJobId || !mediaJobService || typeof mediaJobService.refresh !== 'function') fail('MEDIA_JOB_REQUIRED', 'Delegation has no media job', 409)
  const job = await mediaJobService.refresh({ id: delegation.mediaJobId, userId: delegation.userId })
  if (!TERMINAL.has(job.status)) return Object.freeze({ ready: false, job })
  if (job.status !== 'succeeded') fail('MEDIA_JOB_FAILED', `Media job ended as ${job.status}`, 409)
  const output = job.artifacts?.[0]
  if (!output) fail('MEDIA_RESULT_INVALID', 'Media job has no artifact', 502)
  const kind = delegation.mediaRequest.operation === 'video.render' ? 'video' : 'image'
  let composer = null
  if (kind === 'video') {
    if (typeof prepareComposerProject !== 'function') fail('COMPOSER_ARTIFACT_SETUP_REQUIRED', 'Composer artifact verification is not configured', 503)
    composer = prepareComposerProject({ project: delegation.mediaRequest.composerProject, hints: delegation.mediaRequest.genomeHints })
    if (!output.composerProjectSha256 || composer?.projectSha256 !== output.composerProjectSha256) fail('COMPOSER_PROJECT_CHECKSUM_MISMATCH', 'Composer project does not match the rendered media', 409)
  }
  const artifactInput = {
    userId: delegation.userId,
    projectId: delegation.projectId,
    campaignId: delegation.campaignId,
    type: 'social',
    purpose: delegation.objective,
    channel: delegation.channels.length === 1 ? delegation.channels[0] : null,
    content: { schemaVersion: 1, kind: 'social-visual-draft', media: { kind, storage: output.storage, objectRef: output.objectRef, mimeType: output.mimeType, sha256: output.sha256, sizeBytes: output.sizeBytes, ...(output.composerProjectSha256 ? { composerProjectSha256: output.composerProjectSha256 } : {}) } },
    provenance: { jobId: job.id },
    provider: job.provider,
    model: job.model,
  }
  let artifact = typeof getArtifact === 'function' ? await getArtifact({ id: job.id, userId: delegation.userId, projectId: delegation.projectId, db }) : null
  if (artifact?.status && artifact.status !== 'draft') fail('MEDIA_ARTIFACT_ALREADY_REVIEWED', 'Media job artifact has already entered review', 409)
  if (artifact && (artifact.provenance?.jobId !== job.id || artifact.outputChecksum !== output.sha256 || artifact.purpose !== artifactInput.purpose || artifact.channel !== artifactInput.channel || canonicalStringify(artifact.content) !== canonicalStringify(artifactInput.content) || (composer && canonicalStringify(artifact.genome ?? null) !== canonicalStringify(composer.genome)))) fail('MEDIA_ARTIFACT_CONFLICT', 'Media job artifact binding conflicts with existing content', 409)
  if (!artifact) {
    try {
      artifact = kind === 'video'
        ? await (typeof saveComposerArtifact === 'function' ? saveComposerArtifact : () => fail('COMPOSER_ARTIFACT_SETUP_REQUIRED', 'Composer artifact persistence is not configured', 503))({ ...artifactInput, artifactId: job.id, composerProject: composer.project, genomeHints: delegation.mediaRequest.genomeHints }, db)
        : await (typeof saveArtifact === 'function' ? saveArtifact : () => fail('ARTIFACT_SETUP_REQUIRED', 'Artifact persistence is not configured', 503))(artifactInput, db, { id: job.id })
    } catch (error) {
      if (error?.code !== '23505' || typeof getArtifact !== 'function') throw error
      artifact = await getArtifact({ id: job.id, userId: delegation.userId, projectId: delegation.projectId, db })
      if (!artifact || artifact.status !== 'draft' || artifact.provenance?.jobId !== job.id || artifact.outputChecksum !== output.sha256 || artifact.purpose !== artifactInput.purpose || artifact.channel !== artifactInput.channel || canonicalStringify(artifact.content) !== canonicalStringify(artifactInput.content) || (composer && canonicalStringify(artifact.genome ?? null) !== canonicalStringify(composer.genome))) throw error
    }
  }
  return Object.freeze({ ready: true, job, artifact })
}
