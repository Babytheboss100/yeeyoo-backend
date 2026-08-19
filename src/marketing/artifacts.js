import crypto from 'node:crypto'
import { pool } from '../db.js'
import { canonicalStringify } from '../mediaEngine/contracts/workerApi.js'

export const ARTIFACT_SCHEMA_VERSION = 1
export const ARTIFACT_CHECKSUM_VERSION = 'yeeyoo.artifact.content.sha256.v1'
export const LEGACY_ARTIFACT_CHECKSUM_VERSION = 'yeeyoo.artifact.legacy-pg-jsonb.v1'
export const ARTIFACT_TYPES = Object.freeze(['copy','social','seo','email','ads','funnel','launch','report'])
const SHA256_RE = /^[a-f0-9]{64}$/
const transitions = Object.freeze({ draft: ['approved','rejected','archived'], approved: ['archived'], rejected: ['draft','archived'], archived: [] })

export function artifactContentChecksum({ content, provenance }) {
  return crypto.createHash('sha256').update(canonicalStringify({ content, provenance })).digest('hex')
}
export function artifactOutputChecksum(content) {
  const value = content?.media?.sha256
  if (value == null) return null
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError('content.media.sha256 must be a lowercase SHA-256 digest')
  return value
}
export function verifyArtifactChecksums(artifact) {
  const fail = (message, code = 'ARTIFACT_CHECKSUM_INVALID') => { throw Object.assign(new Error(message), { code }) }
  if (!artifact || typeof artifact.contentChecksum !== 'string' || !SHA256_RE.test(artifact.contentChecksum)) fail('Artifact checksum is missing or invalid')
  if (artifact.outputChecksum != null && !SHA256_RE.test(artifact.outputChecksum)) fail('Artifact output checksum is invalid')
  if (artifact.checksumVersion === ARTIFACT_CHECKSUM_VERSION) {
    if (artifact.contentChecksum !== artifactContentChecksum(artifact) || artifact.outputChecksum !== artifactOutputChecksum(artifact.content)) fail('Artifact immutable content does not match its checksum', 'ARTIFACT_CHECKSUM_MISMATCH')
  } else if (artifact.checksumVersion !== LEGACY_ARTIFACT_CHECKSUM_VERSION) fail('Artifact checksum version is unsupported', 'ARTIFACT_CHECKSUM_VERSION_UNSUPPORTED')
  return true
}
export function createArtifactRecord(input, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  if (!input.projectId || !input.userId) throw new Error('projectId and userId are required')
  if (!ARTIFACT_TYPES.includes(input.type)) throw new Error('Unsupported artifact type')
  if (!input.purpose?.trim() || !input.content || typeof input.content !== 'object' || Array.isArray(input.content)) throw new Error('purpose and content are required')
  const artifact = { id, rootId: input.rootId || id, parentId: input.parentId || null, userId: input.userId, projectId: input.projectId, campaignId: input.campaignId || null, type: input.type, schemaVersion: ARTIFACT_SCHEMA_VERSION, artifactVersion: Number(input.artifactVersion) || 1, status: 'draft', purpose: input.purpose.trim(), channel: input.channel || null, content: structuredClone(input.content), provenance: { marketingProfileVersion: input.provenance?.marketingProfileVersion ?? null, brandDnaVersion: input.provenance?.brandDnaVersion ?? null, competitorIds: [...new Set(input.provenance?.competitorIds || [])], jobId: input.provenance?.jobId || null, derivedFromArtifactId: input.provenance?.derivedFromArtifactId || null, generatedAt: input.provenance?.generatedAt || now }, provider: input.provider || 'deterministic-local', model: input.model || 'copy-fixture-v1', checksumVersion: ARTIFACT_CHECKSUM_VERSION, createdAt: now }
  artifact.contentChecksum = artifactContentChecksum(artifact)
  artifact.outputChecksum = artifactOutputChecksum(artifact.content)
  return artifact
}
export const decodeArtifact = row => row && ({ id: row.id, rootId: row.root_id || row.id, parentId: row.parent_id || null, userId: row.user_id, projectId: row.project_id, campaignId: row.campaign_id, type: row.type, schemaVersion: row.schema_version, artifactVersion: row.artifact_version, status: row.status, purpose: row.purpose, channel: row.channel, content: row.content, provenance: row.provenance, provider: row.provider, model: row.model, checksumVersion: row.checksum_version, contentChecksum: row.content_checksum, outputChecksum: row.output_checksum, genome: row.genome, approvedAt: row.approved_at, createdAt: row.created_at, updatedAt: row.updated_at })
export async function saveArtifact(input, db = pool, { id } = {}) { const a=createArtifactRecord(input,id?{id}:undefined); const {rows}=await db.query(`INSERT INTO marketing_artifacts (id,root_id,parent_id,user_id,project_id,campaign_id,type,schema_version,artifact_version,status,purpose,channel,content,provenance,provider,model,checksum_version,content_checksum,output_checksum) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,[a.id,a.rootId,a.parentId,a.userId,a.projectId,a.campaignId,a.type,a.schemaVersion,a.artifactVersion,a.purpose,a.channel,JSON.stringify(a.content),JSON.stringify(a.provenance),a.provider,a.model,a.checksumVersion,a.contentChecksum,a.outputChecksum]); const saved=decodeArtifact(rows[0]); verifyArtifactChecksums(saved); return saved }
export async function listArtifacts({ userId, projectId, type, db = pool }) { const values=[userId,projectId]; let sql='SELECT * FROM marketing_artifacts WHERE user_id=$1 AND project_id=$2'; if(type){values.push(type);sql+=` AND type=$${values.length}`} const {rows}=await db.query(`${sql} ORDER BY updated_at DESC`,values); return rows.map(row=>{const artifact=decodeArtifact(row);verifyArtifactChecksums(artifact);return artifact}) }
export async function transitionArtifact({ id,userId,projectId,to,db=pool }) { const current=await db.query('SELECT * FROM marketing_artifacts WHERE id=$1 AND user_id=$2 AND project_id=$3',[id,userId,projectId]); const artifact=decodeArtifact(current.rows[0]); if(!artifact)return null; verifyArtifactChecksums(artifact); const from=artifact.status; if(!transitions[from].includes(to)){const e=new Error(`Invalid artifact transition ${from} -> ${to}`);e.code='INVALID_TRANSITION';throw e} const {rows}=await db.query(`UPDATE marketing_artifacts SET status=$1, approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END, approved_at=CASE WHEN $1='approved' THEN NOW() ELSE approved_at END, updated_at=NOW() WHERE id=$3 AND user_id=$2 AND project_id=$4 AND content_checksum=$5 AND output_checksum IS NOT DISTINCT FROM $6 RETURNING *`,[to,userId,id,projectId,artifact.contentChecksum,artifact.outputChecksum]); const updated=decodeArtifact(rows[0]);if(!updated)throw Object.assign(new Error('Artifact changed while approval was being applied'),{code:'ARTIFACT_CHECKSUM_MISMATCH'});verifyArtifactChecksums(updated);return updated }
export async function getArtifact({id,userId,projectId,db=pool}){const {rows}=await db.query('SELECT * FROM marketing_artifacts WHERE id=$1 AND user_id=$2 AND project_id=$3',[id,userId,projectId]);const artifact=decodeArtifact(rows[0])||null;if(artifact)verifyArtifactChecksums(artifact);return artifact}
export async function createArtifactVersion({source,userId,projectId,content,provider='manual-edit',model='human',db=pool}){if(!source||source.userId!==userId||source.projectId!==projectId)return null;verifyArtifactChecksums(source);const latest=await db.query('SELECT COALESCE(MAX(artifact_version),0) AS version FROM marketing_artifacts WHERE user_id=$1 AND project_id=$2 AND root_id=$3',[userId,projectId,source.rootId]);return saveArtifact({userId,projectId,rootId:source.rootId,parentId:source.id,campaignId:source.campaignId,type:source.type,artifactVersion:Number(latest.rows[0].version)+1,purpose:source.purpose,channel:source.channel,content,provenance:{...source.provenance,derivedFromArtifactId:source.id},provider,model},db)}
