import crypto from 'node:crypto'
import { canonicalStringify } from '../contracts/workerApi.js'
import { MediaJobError } from '../jobs/errors.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const OBJECT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/

function fail() { throw new MediaJobError('MEDIA_ASSET_NOT_AVAILABLE', 'Approved media asset is unavailable', { status: 404 }) }

export async function getApprovedMediaAsset({ db, userId, projectId, artifactId } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('Approved media preview requires an injected database')
  if (![userId, projectId, artifactId].every(value => typeof value === 'string' && value.trim())) fail()
  const { rows } = await db.query(`SELECT a.id,a.content,a.provenance,a.checksum_version,a.content_checksum,a.output_checksum,
    (latest.decision='approved' AND latest.checksum_version=a.checksum_version AND latest.content_checksum=a.content_checksum AND latest.output_checksum IS NOT DISTINCT FROM a.output_checksum) AS approval_current
    FROM marketing_artifacts a
    LEFT JOIN LATERAL (
      SELECT d.decision,d.checksum_version,d.content_checksum,d.output_checksum
      FROM marketing_approval_decisions d
      WHERE d.user_id=a.user_id AND d.project_id=a.project_id AND d.artifact_id=a.id
        AND d.artifact_version=a.artifact_version AND d.revoked_at IS NULL
      ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
    ) latest ON TRUE
    WHERE a.id=$3 AND a.user_id=$1 AND a.project_id=$2 AND a.status='approved'`, [userId, projectId, artifactId])
  const row = rows[0]
  const media = row?.content?.media
  const supported = media?.kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : media?.kind === 'video' ? ['video/mp4'] : []
  if (!row || row.approval_current !== true || !supported.includes(media?.mimeType) || !SHA256_RE.test(media.sha256 || '') || row.output_checksum !== media.sha256 || !OBJECT_REF_RE.test(media.objectRef || '') || media.objectRef.includes('..') || media.objectRef.includes('://') || media.objectRef.startsWith('/')) fail()
  if (row.checksum_version === 'yeeyoo.artifact.content.sha256.v1') {
    const digest = crypto.createHash('sha256').update(canonicalStringify({ content: row.content, provenance: row.provenance })).digest('hex')
    if (digest !== row.content_checksum) fail()
  } else if (row.checksum_version !== 'yeeyoo.artifact.legacy-pg-jsonb.v1') fail()
  return Object.freeze({ artifactId: row.id, objectRef: media.objectRef, mimeType: media.mimeType, sha256: media.sha256, sizeBytes: media.sizeBytes })
}
