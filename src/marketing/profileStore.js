import crypto from 'crypto'
import { pool } from '../db.js'
import { createMarketingProfile, profileFromLegacyBusiness } from './profile.js'

export async function getMarketingProfile({ userId, projectId, db = pool }) {
  const { rows } = await db.query('SELECT profile FROM project_marketing_profiles WHERE project_id=$1 AND user_id=$2', [projectId, userId])
  if (rows[0]) return typeof rows[0].profile === 'string' ? JSON.parse(rows[0].profile) : rows[0].profile
  let legacy
  try {
    legacy = await db.query('SELECT * FROM businesses WHERE project_id=$1 AND user_id=$2 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1', [projectId, userId])
  } catch (error) {
    // Older installations have user-owned businesses without project_id. Never
    // fall back to a user-wide row because that could leak context across projects.
    if (error?.code !== '42703') throw error
    return createMarketingProfile({ projectId })
  }
  return legacy.rows[0] ? profileFromLegacyBusiness({ projectId, business: legacy.rows[0] }) : createMarketingProfile({ projectId })
}

export async function saveMarketingProfile({ userId, projectId, profile, source = 'manual', db = pool }) {
  const canonical = createMarketingProfile({ projectId, websiteUrl: profile.websiteUrl, data: profile, source })
  const { rows } = await db.query(`INSERT INTO project_marketing_profiles (id,user_id,project_id,version,website_url,profile,source,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT (project_id) DO UPDATE SET version=EXCLUDED.version,
    website_url=EXCLUDED.website_url,profile=EXCLUDED.profile,source=EXCLUDED.source,updated_at=NOW()
    WHERE project_marketing_profiles.user_id=EXCLUDED.user_id RETURNING profile`,
    [crypto.randomUUID(), userId, projectId, canonical.version, canonical.websiteUrl, JSON.stringify(canonical), source])
  if (!rows[0]) throw new Error('Project marketing profile ownership conflict')
  return typeof rows[0].profile === 'string' ? JSON.parse(rows[0].profile) : rows[0].profile
}
