import crypto from 'node:crypto'
import { pool } from '../db.js'

export const ARTIFACT_SCHEMA_VERSION = 1
export const ARTIFACT_TYPES = Object.freeze(['copy','social','seo','email','ads','funnel','launch','report'])
const transitions = Object.freeze({ draft: ['approved','rejected','archived'], approved: ['archived'], rejected: ['draft','archived'], archived: [] })

export function createArtifactRecord(input, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  if (!input.projectId || !input.userId) throw new Error('projectId and userId are required')
  if (!ARTIFACT_TYPES.includes(input.type)) throw new Error('Unsupported artifact type')
  if (!input.purpose?.trim() || !input.content || typeof input.content !== 'object') throw new Error('purpose and content are required')
  return { id, userId: input.userId, projectId: input.projectId, campaignId: input.campaignId || null, type: input.type,
    schemaVersion: ARTIFACT_SCHEMA_VERSION, artifactVersion: Number(input.artifactVersion) || 1, status: 'draft',
    purpose: input.purpose.trim(), channel: input.channel || null, content: input.content,
    provenance: { marketingProfileVersion: input.provenance?.marketingProfileVersion ?? null, brandDnaVersion: input.provenance?.brandDnaVersion ?? null,
      competitorIds: [...new Set(input.provenance?.competitorIds || [])], jobId: input.provenance?.jobId || null, generatedAt: now },
    provider: input.provider || 'deterministic-local', model: input.model || 'copy-fixture-v1', createdAt: now }
}
const decode = row => row && ({ id: row.id, projectId: row.project_id, campaignId: row.campaign_id, type: row.type, schemaVersion: row.schema_version, artifactVersion: row.artifact_version, status: row.status, purpose: row.purpose, channel: row.channel, content: row.content, provenance: row.provenance, provider: row.provider, model: row.model, approvedAt: row.approved_at, createdAt: row.created_at, updatedAt: row.updated_at })
export async function saveArtifact(input, db = pool) { const a = createArtifactRecord(input); const { rows } = await db.query(`INSERT INTO marketing_artifacts (id,user_id,project_id,campaign_id,type,schema_version,artifact_version,status,purpose,channel,content,provenance,provider,model) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13) RETURNING *`, [a.id,a.userId,a.projectId,a.campaignId,a.type,a.schemaVersion,a.artifactVersion,a.purpose,a.channel,JSON.stringify(a.content),JSON.stringify(a.provenance),a.provider,a.model]); return decode(rows[0]) }
export async function listArtifacts({ userId, projectId, type, db = pool }) { const values=[userId,projectId]; let sql='SELECT * FROM marketing_artifacts WHERE user_id=$1 AND project_id=$2'; if(type){values.push(type);sql+=` AND type=$${values.length}`} const {rows}=await db.query(`${sql} ORDER BY updated_at DESC`,values); return rows.map(decode) }
export async function transitionArtifact({ id,userId,projectId,to,db=pool }) { const current=await db.query('SELECT status FROM marketing_artifacts WHERE id=$1 AND user_id=$2 AND project_id=$3',[id,userId,projectId]); const from=current.rows[0]?.status; if(!from) return null; if(!transitions[from].includes(to)) { const e=new Error(`Invalid artifact transition ${from} -> ${to}`); e.code='INVALID_TRANSITION'; throw e } const {rows}=await db.query(`UPDATE marketing_artifacts SET status=$1, approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END, approved_at=CASE WHEN $1='approved' THEN NOW() ELSE approved_at END, updated_at=NOW() WHERE id=$3 AND user_id=$2 AND project_id=$4 RETURNING *`,[to,userId,id,projectId]); return decode(rows[0]) }
