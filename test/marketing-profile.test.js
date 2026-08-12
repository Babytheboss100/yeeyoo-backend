import test from 'node:test'
import assert from 'node:assert/strict'
import { createMarketingProfile, profileFromLegacyBusiness, MARKETING_PROFILE_SCHEMA, MARKETING_PROFILE_VERSION } from '../src/marketing/profile.js'

test('marketing profile has a stable schema and numeric version', () => {
  const profile = createMarketingProfile({ projectId: 'p1', websiteUrl: 'https://example.com', now: '2026-08-12T00:00:00.000Z' })
  assert.equal(profile.schema, MARKETING_PROFILE_SCHEMA)
  assert.equal(profile.version, MARKETING_PROFILE_VERSION)
  assert.equal(profile.projectId, 'p1')
})

test('legacy Brand DNA adapts without deleting legacy data', () => {
  const profile = profileFromLegacyBusiness({ projectId: 'p1', business: { url: 'https://example.com', brand_dna: { summary: 'Brand', tone: 'Warm', values: ['Trust'] } } })
  assert.equal(profile.brand.summary, 'Brand')
  assert.deepEqual(profile.brand.voice, ['Warm'])
  assert.deepEqual(profile.brand.values, ['Trust'])
})
