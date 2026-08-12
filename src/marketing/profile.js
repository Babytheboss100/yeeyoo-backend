export const MARKETING_PROFILE_SCHEMA = 'yeeyoo.project-marketing-profile'
export const MARKETING_PROFILE_VERSION = 1
export const MARKETING_PROFILE_SCHEMA_VERSION = '1.0.0'

const array = (value) => Array.isArray(value) ? value : []
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const safeJson = (value) => { try { return JSON.parse(value) } catch { return {} } }

export function createMarketingProfile({ projectId, websiteUrl = null, data = {}, now = new Date().toISOString() }) {
  if (!projectId) throw new TypeError('projectId is required')
  const input = object(data)
  return {
    schema: MARKETING_PROFILE_SCHEMA, version: MARKETING_PROFILE_VERSION, schemaVersion: MARKETING_PROFILE_SCHEMA_VERSION, projectId, websiteUrl, updatedAt: now,
    brand: { summary: '', voice: [], values: [], visualIdentity: {}, ...object(input.brand) },
    audiences: array(input.audiences), offers: array(input.offers), competitors: array(input.competitors),
    keywords: array(input.keywords), channels: array(input.channels), funnel: array(input.funnel),
    objectives: array(input.objectives), risks: array(input.risks), evidence: array(input.evidence),
  }
}

export function profileFromLegacyBusiness({ projectId, business }) {
  const dna = object(typeof business?.brand_dna === 'string' ? safeJson(business.brand_dna) : business?.brand_dna)
  const analysis = object(typeof business?.analysis === 'string' ? safeJson(business.analysis) : business?.analysis)
  const audience = dna.audience || analysis.targetAudience
  return createMarketingProfile({ projectId, websiteUrl: business?.url || null, data: {
    brand: { summary: dna.summary || analysis.summary || business?.summary || '', voice: array(dna.voice).length ? dna.voice : [dna.tone || analysis.toneOfVoice].filter(Boolean), values: array(dna.values).length ? dna.values : array(analysis.strengths), visualIdentity: object(dna.visualIdentity) },
    audiences: audience ? [audience] : [], competitors: array(dna.competitors), objectives: array(analysis.goals),
  } })
}

export function plannerContextFromProfile(profile) {
  const brand = object(profile?.brand)
  return { summary: brand.summary || '', toneOfVoice: array(brand.voice).join(', ') || 'Profesjonell men menneskelig', targetAudience: profile?.audiences?.[0] || 'Generell', contentPillars: array(brand.values).length ? brand.values : ['Bransjenyheter', 'Tips', 'Kulissene', 'Kundehistorier'] }
}
