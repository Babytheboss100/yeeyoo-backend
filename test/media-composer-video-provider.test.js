import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { createFakeImageProvider } from '../src/mediaEngine/providers/fakeProvider.js'
import { createComposerVideoProvider, createVideoRenderRequest, validateVideoRenderRequest, VIDEO_RENDER_OPERATION } from '../src/mediaEngine/providers/composerVideo.js'
import { IMAGE_OPERATION } from '../src/mediaEngine/contracts/workerApi.js'
import { createMediaJobService } from '../src/mediaEngine/jobs/jobService.js'
import { createInMemoryMediaJobStore } from '../src/mediaEngine/jobs/memoryJobStore.js'
import { createLocalDiskStorageAdapter } from '../src/mediaEngine/storage/localDiskFake.js'

const PROJECT = Object.freeze({
  schemaVersion: 1,
  kind: 'reel',
  canvas: { width: 108, height: 192, fps: 30, background: '#000000' },
  scenes: [{ id: 'scene-1', duration: 1, elements: [{ id: 'title', type: 'text', text: 'Private campaign copy' }] }],
  captions: [],
})

async function fixture(t, { execute, resolveVideoInput } = {}) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'yeeyoo-video-provider-test-'))
  t.after(() => rm(rootPath, { recursive: true, force: true }))
  const storage = createLocalDiskStorageAdapter({ rootPath })
  const videoProvider = createComposerVideoProvider({ storage, execute })
  const service = createMediaJobService({
    store: createInMemoryMediaJobStore(),
    providers: { [IMAGE_OPERATION]: createFakeImageProvider(), [VIDEO_RENDER_OPERATION]: videoProvider },
    storage,
    resolveVideoInput,
  })
  return { service, storage, videoProvider }
}

function successfulExecutor(seen) {
  return async (request, { storage, signal }) => {
    seen.push({ request, signal })
    const bytes = Buffer.from('fake mp4 bytes')
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const stored = await storage.put({ bytes, mimeType: 'video/mp4', expectedSha256: sha256 })
    return { stored, genome: { v: 1 }, composerProjectSha256: 'a'.repeat(64), render: { durationSeconds: 1, width: 108, height: 192, fps: 30 } }
  }
}

test('video request is canonical, hash-bound and rejects semantic tampering', () => {
  const jobRef = crypto.randomUUID()
  const request = createVideoRenderRequest({ jobRef, project: PROJECT })
  assert.equal(request.operation, VIDEO_RENDER_OPERATION)
  assert.match(request.requestHash, /^[a-f0-9]{64}$/)
  assert.throws(() => validateVideoRenderRequest({ ...request, project: { ...PROJECT, kind: 'changed' } }), { code: 'INVALID_INPUT' })
})

test('same job service routes video through owner-scoped resolver and returns already-stored artifact', async t => {
  const executions = []
  const resolverCalls = []
  const { service, storage } = await fixture(t, {
    execute: successfulExecutor(executions),
    async resolveVideoInput(scope) {
      resolverCalls.push(scope)
      return { project: scope.input.project, assetBindings: {}, genomeHints: { jobIds: ['source-job'] } }
    },
  })
  const input = { projectId: 'project-a', operation: VIDEO_RENDER_OPERATION, project: PROJECT }
  const created = await service.create({ userId: 'user-a', input, idempotencyKey: 'video-1' })
  const replay = await service.create({ userId: 'user-a', input, idempotencyKey: 'video-1' })
  assert.equal(created.job.operation, VIDEO_RENDER_OPERATION)
  assert.equal(created.job.provider, 'composer-video')
  assert.equal(replay.created, false)
  assert.equal(replay.job.id, created.job.id)
  assert.equal(resolverCalls.length, 2)
  assert.equal(resolverCalls[0].userId, 'user-a')
  assert.equal(resolverCalls[0].projectId, 'project-a')
  let completed
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    completed = await service.refresh({ id: created.job.id, userId: 'user-a' })
    if (completed.status === 'succeeded') break
  }
  assert.equal(completed.status, 'succeeded')
  assert.equal(executions.length, 1)
  assert.equal(completed.artifacts[0].mimeType, 'video/mp4')
  assert.deepEqual(completed.artifacts[0].genome, { v: 1 })
  assert.deepEqual(await storage.get(completed.artifacts[0].objectRef), Buffer.from('fake mp4 bytes'))
  assert.doesNotMatch(JSON.stringify(completed), /Private campaign copy/)
})

test('video fails closed without resolver and client objectRefs never reach provider', async t => {
  const executions = []
  const withoutResolver = await fixture(t, { execute: successfulExecutor(executions) })
  await assert.rejects(withoutResolver.service.create({
    userId: 'user-a',
    input: { projectId: 'project-a', operation: VIDEO_RENDER_OPERATION, project: PROJECT },
    idempotencyKey: 'no-resolver',
  }), { code: 'VIDEO_ASSET_RESOLVER_REQUIRED', status: 503 })

  let resolverCalls = 0
  const scoped = await fixture(t, {
    execute: successfulExecutor(executions),
    async resolveVideoInput() { resolverCalls += 1; throw Object.assign(new Error('foreign asset'), { code: 'FOREIGN_ASSET' }) },
  })
  await assert.rejects(scoped.service.create({
    userId: 'user-a',
    input: { projectId: 'project-a', operation: VIDEO_RENDER_OPERATION, project: PROJECT },
    idempotencyKey: 'foreign-asset',
  }), { code: 'FOREIGN_ASSET' })
  await assert.rejects(scoped.service.create({
    userId: 'user-a',
    input: { projectId: 'project-a', operation: VIDEO_RENDER_OPERATION, project: PROJECT, assetBindings: { clip: { objectRef: 'foreign' } } },
    idempotencyKey: 'client-object-ref',
  }), { code: 'INVALID_MEDIA_JOB_REQUEST' })
  assert.equal(resolverCalls, 1)
  assert.equal(executions.length, 0)
})

test('video cancellation aborts executor and remains terminal', async t => {
  let started
  const began = new Promise(resolve => { started = resolve })
  const { service } = await fixture(t, {
    resolveVideoInput: async ({ input }) => ({ project: input.project, assetBindings: {} }),
    execute: async (_request, { signal }) => {
      started()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true })
      })
    },
  })
  const created = await service.create({ userId: 'user-a', input: { projectId: 'project-a', operation: VIDEO_RENDER_OPERATION, project: PROJECT }, idempotencyKey: 'cancel-video' })
  await began
  const cancelled = await service.cancel({ id: created.job.id, userId: 'user-a' })
  assert.equal(cancelled.status, 'cancelled')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await service.refresh({ id: created.job.id, userId: 'user-a' })).status, 'cancelled')
})
