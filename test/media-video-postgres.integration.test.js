import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { canonicalStringify } from '../src/mediaEngine/contracts/workerApi.js'
import { createVideoRenderRequest } from '../src/mediaEngine/providers/composerVideo.js'
import { createPostgresVideoLeaseStore } from '../src/mediaEngine/jobs/postgresVideoLeaseStore.js'
import { createArtifactVideoInputResolver } from '../src/mediaEngine/genome/videoInputResolver.js'

const databaseUrl = process.env.YEEYOO_TEST_DATABASE_URL || ''
let strictPhase13 = false
try { strictPhase13 = new URL(databaseUrl).pathname.replace(/^\//, '') === 'yeeyoo_phase13_test' } catch {}
const integration = { skip: strictPhase13 ? false : 'requires YEEYOO_TEST_DATABASE_URL pointing exactly to yeeyoo_phase13_test' }

async function fixtureScope(pool) {
  const { rows } = await pool.query('SELECT p.id AS project_id,p.user_id FROM projects p JOIN users u ON u.id=p.user_id ORDER BY p.created_at LIMIT 1')
  if (!rows[0]) throw new Error('yeeyoo_phase13_test requires at least one seeded user/project fixture')
  return { userId: rows[0].user_id, projectId: rows[0].project_id }
}

test('PostgreSQL integration: two video runners claim exclusively, heartbeat fences reclaim, and expiry recovers', integration, async () => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const id = crypto.randomUUID()
  try {
    const { userId, projectId } = await fixtureScope(pool)
    const request = createVideoRenderRequest({ jobRef: id, project: { schemaVersion: 1, kind: 'reel', canvas: { width: 108, height: 192, fps: 30, background: '#000' }, scenes: [{ id: 's', duration: 1, elements: [] }], captions: [] } })
    await pool.query(`INSERT INTO ai_jobs
      (id,user_id,project_id,kind,provider,model,status,idempotency_key,input,artifacts,usage,retry_count,max_retries,available_at)
      VALUES ($1,$2,$3,'video.render','composer-video','composer-v0.3.1','queued',$4,$5::jsonb,'[]'::jsonb,'{}'::jsonb,0,2,NOW())`,
    [id, userId, projectId, `lease-it-${id}`, JSON.stringify({ mediaEngine: { schemaVersion: 'yeeyoo.media.job-store.pg.v1', version: 1, workerRequest: request } })])
    const first = createPostgresVideoLeaseStore({ db: pool })
    const second = createPostgresVideoLeaseStore({ db: pool })
    const claims = await Promise.all([first.claim({ workerId: 'integration-a', leaseSeconds: 30 }), second.claim({ workerId: 'integration-b', leaseSeconds: 30 })])
    assert.equal(claims.filter(Boolean).length, 1)
    const winner = claims.find(Boolean).leaseOwner
    assert.equal(await first.heartbeat({ id, workerId: winner, leaseSeconds: 30 }), true)
    assert.equal(await second.claim({ workerId: 'integration-other', leaseSeconds: 30 }), null)
    await pool.query('UPDATE ai_jobs SET lease_expires_at=NOW()-INTERVAL \'1 second\' WHERE id=$1', [id])
    await second.recoverExpired()
    const reclaimed = await second.claim({ workerId: 'integration-reclaimer', leaseSeconds: 30 })
    assert.equal(reclaimed.id, id)
    assert.equal(reclaimed.leaseOwner, 'integration-reclaimer')
    await pool.query("UPDATE ai_jobs SET status='cancelled',finished_at=NOW(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [id])
    assert.equal(await second.heartbeat({ id, workerId: 'integration-reclaimer', leaseSeconds: 30 }), false)
    assert.equal(await second.complete({ id, workerId: 'integration-reclaimer', artifacts: [], usage: {} }), null)
  } finally {
    await pool.query('DELETE FROM ai_jobs WHERE id=$1', [id]).catch(() => {})
    await pool.end()
  }
})

test('PostgreSQL integration: resolveVideoInput returns only approved checksum-bound tenant artifacts', integration, async () => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const artifactId = `media-it-${crypto.randomUUID()}`
  const decisionId = crypto.randomUUID()
  const rejectionId = crypto.randomUUID()
  try {
    const { userId, projectId } = await fixtureScope(pool)
    const outputSha = crypto.createHash('sha256').update(artifactId).digest('hex')
    const content = { media: { kind: 'video', objectRef: `media/${outputSha}.mp4`, mimeType: 'video/mp4', sha256: outputSha, sizeBytes: 123 } }
    const provenance = { jobId: crypto.randomUUID(), generatedAt: new Date().toISOString() }
    const contentChecksum = crypto.createHash('sha256').update(canonicalStringify({ content, provenance })).digest('hex')
    await pool.query(`INSERT INTO marketing_artifacts
      (id,root_id,parent_id,user_id,project_id,type,schema_version,artifact_version,status,purpose,content,provenance,provider,model,checksum_version,content_checksum,output_checksum,approved_by,approved_at)
      VALUES ($1,$1,NULL,$2,$3,'video',1,1,'approved','media integration fixture',$4::jsonb,$5::jsonb,'composer-video','composer-v0.3.1','yeeyoo.artifact.content.sha256.v1',$6,$7,$2,NOW())`,
    [artifactId, userId, projectId, JSON.stringify(content), JSON.stringify(provenance), contentChecksum, outputSha])
    await pool.query(`INSERT INTO marketing_approval_decisions
      (id,user_id,project_id,artifact_id,artifact_version,decision,decided_at,checksum_version,content_checksum,output_checksum)
      VALUES ($1,$2,$3,$4,1,'approved',NOW(),'yeeyoo.artifact.content.sha256.v1',$5,$6)`,
    [decisionId, userId, projectId, artifactId, contentChecksum, outputSha])
    const project = { schemaVersion: 1, kind: 'reel', canvas: { width: 108, height: 192, fps: 30, background: '#000' }, scenes: [{ id: 's', duration: 1, elements: [{ id: 'v', type: 'video', assetId: artifactId }] }], captions: [] }
    const resolver = createArtifactVideoInputResolver({ db: pool })
    const resolved = await resolver({ userId, projectId, input: { project } })
    assert.deepEqual(resolved.assetBindings[artifactId], { objectRef: content.media.objectRef, mimeType: 'video/mp4', sha256: outputSha })
    await assert.rejects(resolver({ userId: crypto.randomUUID(), projectId, input: { project } }), { code: 'VIDEO_ASSET_NOT_AVAILABLE' })
    await pool.query(`INSERT INTO marketing_approval_decisions
      (id,user_id,project_id,artifact_id,artifact_version,decision,decided_at,checksum_version,content_checksum,output_checksum)
      VALUES ($1,$2,$3,$4,1,'rejected',NOW()+INTERVAL '1 millisecond','yeeyoo.artifact.content.sha256.v1',$5,$6)`,
    [rejectionId, userId, projectId, artifactId, contentChecksum, outputSha])
    await assert.rejects(resolver({ userId, projectId, input: { project } }), { code: 'VIDEO_ASSET_NOT_SUITABLE' })
  } finally {
    await pool.query('DELETE FROM marketing_approval_decisions WHERE artifact_id=$1', [artifactId]).catch(() => {})
    await pool.query('DELETE FROM marketing_artifacts WHERE id=$1', [artifactId]).catch(() => {})
    await pool.end()
  }
})
