import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createSosyDelegation } from '../src/sosy/domain.js'
import { finalizeSosyMediaJob, startSosyMediaJob } from '../src/sosy/mediaWorkflow.js'

const sha = 'a'.repeat(64)
const base = {
  id: 'delegation-1', userId: 'user-1', projectId: 'project-1', taskType: 'content.create',
  objective: 'Launch the product', channels: ['instagram'],
  languages: { conversationLanguage: 'no', outputLanguage: 'en' },
}

test('Tony-linked visual delegation normalizes hints and starts an existing media job without new authority', async () => {
  const delegation = createSosyDelegation({ ...base, tonyPlanId: 'tony-plan-1', mediaRequest: { operation: 'image.generate', prompt: 'Product on a clean table', steps: 8, seed: 7, genomeHints: { narrative: 'reveal', hookType: 'question', ctaType: 'shop', audience: 'founders' } } }, { id: base.id })
  let call
  const result = await startSosyMediaJob({ delegation, idempotencyKey: 'request-1', mediaJobService: { create: async value => { call = value; return { created: true, job: { id: 'job-1', status: 'queued' } } } } })
  assert.equal(result.job.id, 'job-1')
  assert.deepEqual(call, { userId: 'user-1', idempotencyKey: 'request-1', input: { projectId: 'project-1', operation: 'image.generate', prompt: 'Product on a clean table', seed: 7, steps: 8 } })
  assert.equal(delegation.tonyPlanId, 'tony-plan-1')
  assert.deepEqual(delegation.mediaRequest.genomeHints, { narrative: 'reveal', hookType: 'question', ctaType: 'shop', audience: 'founders', language: 'en', audienceSegment: 'founders' })
})

test('pending media result stays in the existing delegation flow', async () => {
  const result = await finalizeSosyMediaJob({ delegation: { ...base, mediaJobId: 'job-1', mediaRequest: { operation: 'image.generate' } }, mediaJobService: { refresh: async () => ({ id: 'job-1', status: 'processing' }) } })
  assert.equal(result.ready, false)
  assert.equal(result.job.status, 'processing')
})

test('video result becomes a draft Composer artifact with delegation genome hints', async () => {
  const genomeHints = { narrative: 'demo', hookType: 'visual', ctaType: 'learn', audience: 'teams', audienceSegment: 'teams', language: 'en' }
  const composerProject = { schemaVersion: '0.3', width: 1080, height: 1920, fps: 30, durationMs: 1000, tracks: [] }
  let saved
  const artifact = { id: 'artifact-1', status: 'draft' }
  const result = await finalizeSosyMediaJob({
    delegation: { ...base, mediaJobId: 'job-1', campaignId: null, mediaRequest: { operation: 'video.render', composerProject, genomeHints } },
    mediaJobService: { refresh: async () => ({ id: 'job-1', status: 'succeeded', provider: 'composer-video', model: 'yeeyoo-media-composer-0.3.0', artifacts: [{ storage: 'test', objectRef: 'media/x.mp4', mimeType: 'video/mp4', sha256: sha, sizeBytes: 12, composerProjectSha256: 'b'.repeat(64) }] }) },
    saveArtifact: async () => assert.fail('ordinary artifact path must not handle Composer output'),
    saveComposerArtifact: async input => { saved = input; return artifact },
    getArtifact: async () => null,
    prepareComposerProject: () => ({ project: composerProject, projectSha256: 'b'.repeat(64) }),
  })
  assert.equal(result.ready, true)
  assert.equal(result.artifact.status, 'draft')
  assert.deepEqual(saved.composerProject, composerProject)
  assert.deepEqual(saved.genomeHints, genomeHints)
  assert.equal(saved.artifactId, 'job-1')
  assert.equal(saved.content.media.composerProjectSha256, 'b'.repeat(64))
  assert.equal(saved.content.media.sha256, sha)
  assert.equal(saved.provenance.jobId, 'job-1')
})

test('image result becomes an ordinary draft artifact and never approves it', async () => {
  let saved
  const result = await finalizeSosyMediaJob({
    delegation: { ...base, mediaJobId: 'job-2', campaignId: null, mediaRequest: { operation: 'image.generate', genomeHints: {} } },
    mediaJobService: { refresh: async () => ({ id: 'job-2', status: 'succeeded', provider: 'fake-image', model: 'z-image-turbo', artifacts: [{ storage: 'test', objectRef: 'media/x.png', mimeType: 'image/png', sha256: sha, sizeBytes: 12 }] }) },
    saveArtifact: async input => { saved = input; return { id: 'artifact-2', status: 'draft' } },
    getArtifact: async () => null,
  })
  assert.equal(result.artifact.status, 'draft')
  assert.equal(saved.content.media.kind, 'image')
  assert.equal(Object.hasOwn(saved, 'approvedAt'), false)
})

test('finalize replays the deterministic job artifact instead of creating duplicate drafts', async () => {
  let saves = 0
  const existing = { id: 'job-2', status: 'draft', purpose: base.objective, channel: 'instagram', outputChecksum: sha, provenance: { jobId: 'job-2' }, content: { schemaVersion: 1, kind: 'social-visual-draft', media: { kind: 'image', storage: 'test', objectRef: 'media/x.png', mimeType: 'image/png', sha256: sha, sizeBytes: 12 } } }
  const result = await finalizeSosyMediaJob({
    delegation: { ...base, mediaJobId: 'job-2', mediaRequest: { operation: 'image.generate', genomeHints: {} } },
    mediaJobService: { refresh: async () => ({ id: 'job-2', status: 'succeeded', provider: 'fake-image', model: 'z-image-turbo', artifacts: [{ storage: 'test', objectRef: 'media/x.png', mimeType: 'image/png', sha256: sha, sizeBytes: 12 }] }) },
    getArtifact: async () => existing,
    saveArtifact: async () => { saves += 1 },
  })
  assert.equal(result.artifact, existing)
  assert.equal(saves, 0)
})

test('finalize never sends an already reviewed artifact back to waiting approval', async () => {
  await assert.rejects(finalizeSosyMediaJob({
    delegation: { ...base, mediaJobId: 'job-2', mediaRequest: { operation: 'image.generate', genomeHints: {} } },
    mediaJobService: { refresh: async () => ({ id: 'job-2', status: 'succeeded', provider: 'fake-image', model: 'z-image-turbo', artifacts: [{ storage: 'test', objectRef: 'media/x.png', mimeType: 'image/png', sha256: sha, sizeBytes: 12 }] }) },
    getArtifact: async () => ({ id: 'job-2', status: 'approved' }),
  }), error => error.code === 'MEDIA_ARTIFACT_ALREADY_REVIEWED')
})

test('video finalization rejects a Composer project that differs from rendered output', async () => {
  await assert.rejects(finalizeSosyMediaJob({
    delegation: { ...base, mediaJobId: 'job-3', mediaRequest: { operation: 'video.render', composerProject: {}, genomeHints: {} } },
    mediaJobService: { refresh: async () => ({ id: 'job-3', status: 'succeeded', provider: 'composer-video', model: 'composer', artifacts: [{ storage: 'test', objectRef: 'media/x.mp4', mimeType: 'video/mp4', sha256: sha, sizeBytes: 12, composerProjectSha256: 'b'.repeat(64) }] }) },
    prepareComposerProject: () => ({ project: {}, projectSha256: 'c'.repeat(64) }),
  }), error => error.code === 'COMPOSER_PROJECT_CHECKSUM_MISMATCH')
})

test('media request rejects unsupported fields and operations before any job call', () => {
  assert.throws(() => createSosyDelegation({ ...base, mediaRequest: { operation: 'image.generate', prompt: 'x', objectRef: 'foreign' } }), error => error.code === 'INVALID_MEDIA_REQUEST')
  assert.throws(() => createSosyDelegation({ ...base, mediaRequest: { operation: 'audio.generate' } }), error => error.code === 'INVALID_MEDIA_REQUEST')
})

test('visual delegation migration binds media jobs to the same tenant and project', () => {
  const sql = fs.readFileSync(new URL('../migrations/2026-08-29_sosy_media_delegations.sql', import.meta.url), 'utf8')
  assert.match(sql, /FOREIGN KEY\(media_job_id,user_id,project_id\)/)
  assert.match(sql, /REFERENCES ai_jobs\(id,user_id,project_id\)/)
  assert.doesNotMatch(sql, /media_job_id UUID REFERENCES ai_jobs\(id\)/)
})

test('Sosy visual route fails closed unless the shared media job is durable', () => {
  const source = fs.readFileSync(new URL('../src/routes/sosy.js', import.meta.url), 'utf8')
  assert.match(source, /env\.MEDIA_JOB_STORE !== 'postgres'/)
  assert.match(source, /SOSY_MEDIA_DURABLE_STORE_REQUIRED/)
  assert.match(source, /createSosyRouter\(\{ env = process\.env, db = pool, mediaJobService/)
})
