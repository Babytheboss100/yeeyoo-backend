import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { COMPOSER_BUILD, ComposerProjectError, prepareComposerProject } from '../src/mediaEngine/composer/project.js'
import { assertRenderApproval, createRenderApprovalBinding, revokeRenderApproval } from '../src/mediaEngine/composer/approvalBinding.js'
import { executeVideoRender } from '../src/mediaEngine/executors/videoRender.js'

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const project = Object.freeze({ schemaVersion: 1, kind: 'reel', scenes: [{ id: 'scene-1', elements: [] }] })

function composerApi({ refs = [] } = {}) {
  return {
    validateProject(value) { return { ok: true, errors: [], project: structuredClone(value) } },
    deriveGenome(value, hints) { return { v: 1, format: value.kind, production: { ...hints, job_ids: hints.jobIds || [] } } },
    collectAssetRefs() { return refs },
  }
}

function memoryStorage(seed = {}) {
  const objects = new Map(Object.entries(seed))
  return Object.freeze({
    capabilities() { return { persistent: false } },
    async stat(ref) {
      const item = objects.get(ref)
      if (!item) throw new Error('missing')
      return { objectRef: ref, mimeType: item.mimeType, sizeBytes: item.bytes.length, sha256: hash(item.bytes), persistent: false }
    },
    async get(ref) { return Buffer.from(objects.get(ref).bytes) },
    async put({ bytes, mimeType, expectedSha256 }) {
      const data = Buffer.from(bytes)
      assert.equal(hash(data), expectedSha256)
      const objectRef = `media/${expectedSha256}.mp4`
      objects.set(objectRef, { bytes: data, mimeType })
      return { objectRef, mimeType, sizeBytes: data.length, sha256: expectedSha256, persistent: false }
    },
  })
}

test('composer wrapper validates, hashes and derives genome with truthful build metadata', () => {
  const api = composerApi()
  const result = prepareComposerProject({ project, hints: { jobIds: ['job-1'] }, ...api })
  assert.match(result.projectSha256, /^[a-f0-9]{64}$/)
  assert.equal(result.genome.production.composerProjectSha256, result.projectSha256)
  assert.deepEqual(result.composer, { source: 'yeeyoo-media-composer', apiVersion: '0.3', ...COMPOSER_BUILD })
})

test('composer wrapper exposes bounded validation codes and fails closed on degraded genome', () => {
  assert.throws(() => prepareComposerProject({
    project,
    validateProject: () => ({ ok: false, errors: Array.from({ length: 20 }, (_, i) => ({ code: `E${i}`, path: `p${i}`, message: 'secret' })) }),
    deriveGenome: () => ({}),
  }), error => error instanceof ComposerProjectError && error.code === 'COMPOSER_PROJECT_INVALID' && error.details.length === 8 && !JSON.stringify(error.details).includes('secret'))
  const api = composerApi()
  assert.throws(() => prepareComposerProject({ ...api, project, deriveGenome: () => ({ v: 1, derivation_failed: true }) }), error => error.code === 'COMPOSER_GENOME_DERIVATION_FAILED')
})

test('video executor materializes StorageAdapter assets, verifies render bytes, stores MP4 and cleans workspace', async () => {
  const source = Buffer.from('source-video')
  const sourceSha = hash(source)
  const sourceRef = `media/${sourceSha}.mp4`
  const storage = memoryStorage({ [sourceRef]: { bytes: source, mimeType: 'video/mp4' } })
  const api = composerApi({ refs: [{ kind: 'video', ref: { assetId: 'clip-1' }, key: 'el:clip' }] })
  const output = Buffer.from('verified-mp4-output')
  const seen = {}
  const result = await executeVideoRender({
    project,
    genomeHints: { jobIds: ['job-1'] },
    assetBindings: { 'clip-1': { objectRef: sourceRef, mimeType: 'video/mp4', sha256: sourceSha } },
    storage,
    ...api,
    workspaceRoot: path.join(os.tmpdir(), `yeeyoo-executor-test-${crypto.randomUUID()}`),
    async composeVideo(value, options) {
      seen.project = value
      seen.outPath = options.outPath
      seen.source = await readFile(options.assetMap['clip-1'])
      await writeFile(options.outPath, output)
      return { outPath: options.outPath, sha256: hash(output), sizeBytes: output.length, durationSeconds: 1, width: 1080, height: 1920, fps: 30 }
    },
  })
  assert.deepEqual(seen.project, project)
  assert.deepEqual(seen.source, source)
  assert.equal(result.stored.sha256, hash(output))
  assert.equal(result.artifactContent.media.composerProjectSha256, result.composerProjectSha256)
  await assert.rejects(readFile(seen.outPath))
})

test('render approval binds exact artifact version and both checksums, and revocation is immutable', () => {
  const sha = 'a'.repeat(64)
  const projectSha = 'b'.repeat(64)
  const artifact = { id: 'artifact-1', userId: 'user-1', projectId: 'project-1', artifactVersion: 2, content: { media: { sha256: sha, composerProjectSha256: projectSha } } }
  const binding = createRenderApprovalBinding({ userId: artifact.userId, projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: 2, outputSha256: sha, composerProjectSha256: projectSha })
  assert.equal(assertRenderApproval(binding, artifact), true)
  assert.throws(() => assertRenderApproval(binding, { ...artifact, artifactVersion: 3 }), error => error.code === 'STALE_OR_FORGED_APPROVAL')
  const revoked = revokeRenderApproval(binding, { reason: 'superseded' })
  assert.equal(binding.revokedAt, null)
  assert.throws(() => assertRenderApproval(revoked, artifact), error => error.code === 'APPROVAL_REVOKED')
})
