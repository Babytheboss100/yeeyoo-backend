import { pool } from '../db.js'

const PLATFORM_BY_CHANNEL = Object.freeze({ web: 'website', email: 'email', ads: 'facebook', social: 'instagram', linkedin: 'linkedin', instagram: 'instagram', facebook: 'facebook', x: 'x' })

export function artifactToPostDraft(artifact, { scheduledAt = null } = {}) {
  if (!artifact || artifact.status !== 'approved') throw Object.assign(new Error('Artifact must be approved before enqueue'), { code: 'ARTIFACT_NOT_APPROVED' })
  const content = artifact.content?.socialCopy || artifact.content?.adCopy?.primaryText || artifact.content?.email?.body || artifact.content?.subheadline || artifact.content?.headline
  if (!String(content || '').trim()) throw Object.assign(new Error('Artifact has no publishable content'), { code: 'EMPTY_ARTIFACT' })
  const platform = PLATFORM_BY_CHANNEL[artifact.channel] || artifact.channel || 'website'
  return { userId: artifact.userId, projectId: artifact.projectId, artifactId: artifact.id, artifactVersion: artifact.artifactVersion, platform, content: String(content).trim(), scheduledAt, status: scheduledAt ? 'scheduled' : 'approved' }
}

export async function enqueueArtifact({ artifact, scheduledAt, db = pool }) {
  const draft = artifactToPostDraft(artifact, { scheduledAt })
  const { rows } = await db.query(`INSERT INTO posts (id,user_id,project_id,platform,content,status,scheduled_at,artifact_id,artifact_version)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id,project_id,artifact_id,artifact_version) DO UPDATE SET id=posts.id RETURNING *`,
    [draft.userId,draft.projectId,draft.platform,draft.content,draft.status,draft.scheduledAt,draft.artifactId,draft.artifactVersion])
  return rows[0]
}
