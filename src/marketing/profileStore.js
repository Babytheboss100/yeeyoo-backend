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

// The brand context a copy model needs, or null when the project has nothing to
// say yet. getMarketingProfile never returns null - a project with no profile
// and no legacy business row still gets an empty canonical profile - so it is
// emptiness, not absence, that disqualifies a project here.
//
// Everything below can originate in crawled text, which this codebase treats as
// evidence and never as instructions. It is therefore trimmed and capped before
// it reaches a prompt, and this helper never throws: a missing or broken profile
// must degrade the copy, never fail the delegation.
const brandText = (value) => {
  const raw = typeof value === 'string' ? value : value?.claim || value?.name || value?.title || value?.summary || ''
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 400)
}
const brandList = (values, limit) => (Array.isArray(values) ? values : []).map(brandText).filter(Boolean).slice(0, limit)

export async function loadBrandContext({ userId, projectId, db = pool }) {
  let profile
  try {
    profile = await getMarketingProfile({ userId, projectId, db })
  } catch {
    return null
  }
  const brand = profile?.brand && typeof profile.brand === 'object' ? profile.brand : {}
  const context = {
    name: brandText(profile?.websiteUrl && hostnameOf(profile.websiteUrl)) || null,
    about: brandText(brand.summary) || null,
    audience: brandList(profile?.audiences, 1)[0] || null,
    tone: brandList(brand.voice, 4).join(', ') || null,
    offers: brandList(profile?.offers, 5),
    objectives: brandList(profile?.objectives, 5),
    keywords: brandList(profile?.keywords, 12).join(', ') || null,
  }
  const populated = context.about || context.audience || context.tone || context.keywords
    || context.offers.length || context.objectives.length
  return populated ? context : null
}

function hostnameOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '') } catch { return '' }
}
