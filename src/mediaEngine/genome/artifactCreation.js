import { pool } from '../../db.js'
import { createArtifactRecord, verifyArtifactChecksums } from '../../marketing/artifacts.js'
import { deriveArtifactGenome } from './bridge.js'
import { prepareVendoredComposerProject } from '../composer/runtime.js'

function decode(row) {
  return row && {
    id: row.id,
    rootId: row.root_id || row.id,
    parentId: row.parent_id || null,
    userId: row.user_id,
    projectId: row.project_id,
    campaignId: row.campaign_id,
    type: row.type,
    schemaVersion: row.schema_version,
    artifactVersion: row.artifact_version,
    status: row.status,
    purpose: row.purpose,
    channel: row.channel,
    content: row.content,
    provenance: row.provenance,
    provider: row.provider,
    model: row.model,
    checksumVersion: row.checksum_version,
    contentChecksum: row.content_checksum,
    outputChecksum: row.output_checksum,
    genome: row.genome,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// This explicit creation path is enabled only after the additive genome
// migration is approved and applied. Ordinary artifact creation remains
// untouched and migration-safe.
export async function saveComposerArtifact({ composerProject, genomeHints = {}, deriveGenome, artifactId, ...artifactInput } = {}, db = pool) {
  const artifact = createArtifactRecord(artifactInput, artifactId ? { id: artifactId } : undefined)
  const genome = deriveGenome
    ? await deriveArtifactGenome({ composerProject, genomeHints, deriveGenome })
    : prepareVendoredComposerProject({ project: composerProject, hints: genomeHints }).genome
  const values = [
    artifact.id,
    artifact.rootId,
    artifact.parentId,
    artifact.userId,
    artifact.projectId,
    artifact.campaignId,
    artifact.type,
    artifact.schemaVersion,
    artifact.artifactVersion,
    artifact.purpose,
    artifact.channel,
    JSON.stringify(artifact.content),
    JSON.stringify(artifact.provenance),
    artifact.provider,
    artifact.model,
    artifact.checksumVersion,
    artifact.contentChecksum,
    artifact.outputChecksum,
    JSON.stringify(genome),
  ]
  const { rows } = await db.query(
    `INSERT INTO marketing_artifacts (id,root_id,parent_id,user_id,project_id,campaign_id,type,schema_version,artifact_version,status,purpose,channel,content,provenance,provider,model,checksum_version,content_checksum,output_checksum,genome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    values,
  )
  const saved=decode(rows[0]);verifyArtifactChecksums(saved);return saved
}
