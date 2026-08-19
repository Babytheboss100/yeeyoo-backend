import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { deriveArtifactGenome, MAX_GENOME_BYTES, MAX_GENOME_DEPTH, MAX_GENOME_NODES, normalizeArtifactGenome } from '../src/mediaEngine/genome/bridge.js'
import { saveComposerArtifact } from '../src/mediaEngine/genome/artifactCreation.js'
import { createArtifactRecord, saveArtifact } from '../src/marketing/artifacts.js'

const ARTIFACT = Object.freeze({
  userId: 'user-a',
  projectId: 'project-a',
  type: 'social',
  purpose: 'Campaign variant',
  channel: 'instagram',
  content: { headline: 'Build measurable growth' },
  provider: 'composer',
  model: 'composer-v0.3.1',
})

test('genome bridge preserves JSON data and calls the supplied composer deriver exactly once', async () => {
  const calls = []
  const composerProject = { scenes: [{ id: 'scene-1' }] }
  const genome = await deriveArtifactGenome({ composerProject, deriveGenome: project => {
    calls.push(project)
    return { schemaVersion: 1, hooks: ['direct'], cta: { kind: 'booking' } }
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0], composerProject)
  assert.deepEqual(genome, { schemaVersion: 1, hooks: ['direct'], cta: { kind: 'booking' } })
})

test('genome rejects arrays, cycles, prototype-bearing objects and oversized payloads', async () => {
  assert.throws(() => normalizeArtifactGenome([]), /must be an object/)
  const cyclic = {}; cyclic.self = cyclic
  assert.throws(() => normalizeArtifactGenome(cyclic), /acyclic JSON/)
  assert.throws(() => normalizeArtifactGenome(new Date()), /plain objects/)
  assert.throws(() => normalizeArtifactGenome({ body: 'x'.repeat(MAX_GENOME_BYTES) }), /size limit/)
  await assert.rejects(deriveArtifactGenome({ composerProject: {}, deriveGenome: null }), /implementation is required/)
})

test('genome traversal is bounded before JSON serialization', () => {
  const deep = {}
  let cursor = deep
  for (let index = 0; index <= MAX_GENOME_DEPTH; index += 1) {
    cursor.child = {}
    cursor = cursor.child
  }
  assert.throws(() => normalizeArtifactGenome(deep), /depth limit/)
  assert.throws(() => normalizeArtifactGenome({ nodes: Array.from({ length: MAX_GENOME_NODES }, () => null) }), /node limit/)
  assert.throws(() => normalizeArtifactGenome({ ['x'.repeat(MAX_GENOME_BYTES)]: true }), /size limit/)
  const accessor = {}
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'must-not-run' })
  assert.throws(() => normalizeArtifactGenome(accessor), /must not contain accessors/)
  assert.throws(() => normalizeArtifactGenome({ sparse: Array(1) }), /acyclic JSON data/)
})

test('ordinary artifacts remain migration-safe until a genome is supplied', async () => {
  let captured
  const db = { query: async (text, values) => {
    captured = { text, values }
    return { rows: [{ id: values[0], user_id: 'user-a', project_id: 'project-a', type: 'social', content: JSON.parse(values[11]), provenance: JSON.parse(values[12]), provider: 'composer', model: 'composer-v0.3.1', checksum_version: values[15], content_checksum: values[16], output_checksum: values[17] }] }
  } }
  const artifact = await saveArtifact(ARTIFACT, db)
  assert.doesNotMatch(captured.text, /,genome\)/)
  assert.equal(captured.values.length, 18)
  assert.equal('genome' in artifact, false)
})

test('composer artifact creation derives and persists genome behind the additive column', async () => {
  let captured
  const derived = { schemaVersion: 1, hook: 'proof-first', target: { channel: 'instagram' } }
  const db = { query: async (text, values) => {
    captured = { text, values }
    return { rows: [{ id: values[0], user_id: 'user-a', project_id: 'project-a', type: 'social', content: JSON.parse(values[11]), provenance: JSON.parse(values[12]), provider: 'composer', model: 'composer-v0.3.1', checksum_version: values[15], content_checksum: values[16], output_checksum: values[17], genome: JSON.parse(values[18]) }] }
  } }
  const artifact = await saveComposerArtifact({ ...ARTIFACT, composerProject: { timeline: [] }, deriveGenome: () => derived }, db)
  assert.match(captured.text, /,genome\)/)
  assert.equal(captured.values.length, 19)
  assert.deepEqual(artifact.genome, derived)
  assert.equal('composerProject' in createArtifactRecord({ ...ARTIFACT, genome: derived }), false)
})

test('prepared migrations preserve the canonical lease source and add only the genome column', () => {
  const leases = fs.readFileSync(new URL('../migrations/2026-08-26_media_job_leases.sql', import.meta.url), 'utf8')
  const genome = fs.readFileSync(new URL('../migrations/2026-08-27_marketing_artifact_genome.sql', import.meta.url), 'utf8')
  for (const sql of [leases, genome]) {
    assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i)
  }
  assert.doesNotMatch(leases, /ALTER TABLE/i)
  for (const column of ['lease_owner', 'lease_expires_at', 'last_heartbeat_at', 'available_at', 'max_retries']) assert.match(leases, new RegExp(column))
  for (const duplicate of ['ADD COLUMN IF NOT EXISTS locked_at', 'ADD COLUMN IF NOT EXISTS locked_by', 'ADD COLUMN IF NOT EXISTS heartbeat_at', 'ADD COLUMN IF NOT EXISTS next_attempt_at', 'ADD COLUMN IF NOT EXISTS max_attempts']) assert.doesNotMatch(leases, new RegExp(duplicate))
  assert.match(genome, /ADD COLUMN IF NOT EXISTS/i)
  assert.match(genome, /CREATE INDEX IF NOT EXISTS/i)
  assert.match(genome, /genome JSONB/i)
  assert.match(genome, /USING GIN \(genome jsonb_path_ops\)/i)
})
