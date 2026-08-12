import test from 'node:test'
import assert from 'node:assert/strict'
import { createMarketingProfile, profileFreshness, profileFromLegacyBusiness, MARKETING_PROFILE_SCHEMA, MARKETING_PROFILE_VERSION } from '../src/marketing/profile.js'

test('marketing profile has a stable schema and numeric version', () => {
  const profile = createMarketingProfile({ projectId: 'p1', websiteUrl: 'https://example.com', now: '2026-08-12T00:00:00.000Z' })
  assert.equal(profile.schema, MARKETING_PROFILE_SCHEMA)
  assert.equal(profile.version, MARKETING_PROFILE_VERSION)
  assert.equal(profile.projectId, 'p1')
  assert.equal(profile.intelligence.source, 'manual')
})

test('marketing intelligence preserves provenance and reports freshness', () => {
  const profile = createMarketingProfile({ projectId: 'p1', now: '2026-08-01T00:00:00.000Z', source: 'marketing-audit', data: { intelligence: { crawledAt: '2026-08-01T00:00:00.000Z', sources: [{ url: 'https://example.com' }], provenance: [{ artifact: 'audit', version: 1 }] } } })
  assert.equal(profile.intelligence.source, 'marketing-audit')
  assert.equal(profile.intelligence.provenance[0].artifact, 'audit')
  assert.equal(profileFreshness(profile, { now: Date.parse('2026-08-02T00:00:00.000Z'), maxAgeMs: 172800000 }).fresh, true)
  assert.equal(profileFreshness(profile, { now: Date.parse('2026-09-02T00:00:00.000Z'), maxAgeMs: 172800000 }).fresh, false)
})

test('legacy Brand DNA adapts without deleting legacy data', () => {
  const profile = profileFromLegacyBusiness({ projectId: 'p1', business: { url: 'https://example.com', brand_dna: { summary: 'Brand', tone: 'Warm', values: ['Trust'] } } })
  assert.equal(profile.brand.summary, 'Brand')
  assert.deepEqual(profile.brand.voice, ['Warm'])
  assert.deepEqual(profile.brand.values, ['Trust'])
})
