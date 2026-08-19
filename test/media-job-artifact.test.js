import assert from 'node:assert/strict'
import test from 'node:test'
import { composerProjectSha256 as hashComposerProject } from '../src/mediaEngine/composer/project.js'
import { prepareMediaJobArtifact } from '../src/mediaEngine/genome/jobArtifact.js'

const sha = 'a'.repeat(64)
const project = { schemaVersion: 1, kind: 'reel', canvas: { width: 108, height: 192, fps: 30, background: '#000000' }, scenes: [{ id: 'scene-1', duration: 1, elements: [] }], captions: [] }
const baseJob = { id: 'job-1', projectId: 'project-1', status: 'succeeded', provider: 'fake-image', model: 'z-image-turbo', artifacts: [{ storage: 'test', objectRef: 'media/a.png', mimeType: 'image/png', sha256: sha, sizeBytes: 10 }] }

test('succeeded image output becomes a draft-only artifact input bound to its job checksum', () => {
  const result = prepareMediaJobArtifact({ job: { ...baseJob, operation: 'image.generate' }, body: { purpose: 'Campaign hero', channel: 'instagram' }, userId: 'user-1' })
  assert.equal(result.artifactInput.userId, 'user-1')
  assert.equal(result.artifactInput.content.media.sha256, sha)
  assert.equal(result.artifactInput.provenance.jobId, 'job-1')
  assert.equal(Object.hasOwn(result.artifactInput, 'status'), false)
})

test('video artifact accepts only the exact project that produced the rendered checksum', () => {
  const composerProjectSha256 = hashComposerProject(project)
  const job = { ...baseJob, operation: 'video.render', provider: 'composer-video', artifacts: [{ ...baseJob.artifacts[0], objectRef: 'media/a.mp4', mimeType: 'video/mp4', composerProjectSha256 }] }
  const result = prepareMediaJobArtifact({ job, body: { purpose: 'Launch reel', channel: 'instagram', composerProject: project, genomeHints: { hookType: 'question' } }, userId: 'user-1', composerProjectSha256 })
  assert.equal(result.artifactInput.content.media.composerProjectSha256, composerProjectSha256)
  assert.equal(result.genomeHints.hookType, 'question')
  assert.throws(() => prepareMediaJobArtifact({ job: { ...job, artifacts: [{ ...job.artifacts[0], composerProjectSha256: 'b'.repeat(64) }] }, body: { purpose: 'Launch reel', channel: 'instagram', composerProject: project }, userId: 'user-1', composerProjectSha256 }), error => error.code === 'COMPOSER_PROJECT_CHECKSUM_MISMATCH')
})

test('artifact preparation rejects unfinished jobs, client references and unknown genome hints', () => {
  assert.throws(() => prepareMediaJobArtifact({ job: { ...baseJob, operation: 'image.generate', status: 'processing' }, body: { purpose: 'x', channel: 'instagram' }, userId: 'user-1' }), error => error.code === 'MEDIA_RESULT_NOT_READY')
  assert.throws(() => prepareMediaJobArtifact({ job: { ...baseJob, operation: 'image.generate' }, body: { purpose: 'x', channel: 'instagram', objectRef: 'foreign' }, userId: 'user-1' }), error => error.code === 'INVALID_ARTIFACT_REQUEST')
  assert.throws(() => prepareMediaJobArtifact({ job: { ...baseJob, operation: 'image.generate' }, body: { purpose: 'x', channel: 'instagram', genomeHints: { privateField: 'x' } }, userId: 'user-1' }), error => error.code === 'INVALID_ARTIFACT_REQUEST')
})
