import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { canonicalStringify } from '../src/mediaEngine/contracts/workerApi.js'
import { getApprovedMediaAsset } from '../src/mediaEngine/genome/assetPreview.js'

const sha = 'a'.repeat(64)
function row(overrides = {}) {
  const content = { media: { kind: 'image', objectRef: `media/${sha}.png`, mimeType: 'image/png', sha256: sha, sizeBytes: 12 } }
  const provenance = { jobId: 'job-1' }
  return { id: 'artifact-1', content, provenance, checksum_version: 'yeeyoo.artifact.content.sha256.v1', content_checksum: crypto.createHash('sha256').update(canonicalStringify({ content, provenance })).digest('hex'), output_checksum: sha, approval_current: true, ...overrides }
}

test('approved browser image preview is latest-decision and tenant scoped', async () => {
  let call
  const asset = await getApprovedMediaAsset({ db: { query: async (sql, params) => { call = { sql, params }; return { rows: [row()] } } }, userId: 'u1', projectId: 'p1', artifactId: 'artifact-1' })
  assert.deepEqual(call.params, ['u1', 'p1', 'artifact-1'])
  assert.match(call.sql, /a\.user_id=\$1 AND a\.project_id=\$2/)
  assert.match(call.sql, /ORDER BY d\.decided_at DESC,d\.id DESC LIMIT 1/)
  assert.deepEqual(asset, { artifactId: 'artifact-1', objectRef: `media/${sha}.png`, mimeType: 'image/png', sha256: sha, sizeBytes: 12 })
})

test('asset preview rejects stale approval, changed checksum and unsupported media', async () => {
  for (const changed of [row({ approval_current: false }), row({ output_checksum: 'b'.repeat(64) }), row({ content: { media: { kind: 'audio', objectRef: `media/${sha}.mp3`, mimeType: 'audio/mpeg', sha256: sha, sizeBytes: 12 } } })]) {
    await assert.rejects(getApprovedMediaAsset({ db: { query: async () => ({ rows: [changed] }) }, userId: 'u1', projectId: 'p1', artifactId: 'artifact-1' }), error => error.code === 'MEDIA_ASSET_NOT_AVAILABLE')
  }
})
