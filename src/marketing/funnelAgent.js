import { generateCopy } from './copyAgent.js'

const clean = value => String(value ?? '').trim()

export function generateFunnel(input, context = {}) {
  const objective = clean(input.objective)
  const audience = clean(input.audience)
  const offer = clean(input.offer)
  if (!objective || !audience || !offer) throw new Error('objective, audience and offer are required')
  const copyInput = { objective, audience, offer, tone: input.tone, channel: 'funnel' }
  const copy = generateCopy(copyInput, context)
  return {
    schemaVersion: 1,
    kind: 'funnel',
    mode: 'deterministic-offline-draft',
    executable: false,
    objective,
    audience,
    offer,
    stages: [
      { key: 'awareness', goal: `Introduce ${offer}`, asset: 'landing-page', copy: { headline: copy.headline, subheadline: copy.subheadline } },
      { key: 'consideration', goal: `Help ${audience} evaluate the offer`, asset: 'email', copy: copy.email },
      { key: 'conversion', goal: objective, asset: 'call-to-action', copy: { cta: copy.cta } },
    ],
    assumptions: ['Conversion rates and traffic are unknown until measured'],
    metrics: [],
    provenance: {
      marketingProfileVersion: context.profile?.version ?? null,
      sourceArtifactIds: [...new Set(input.sourceArtifactIds || [])],
      generator: 'copyAgent.generateCopy',
    },
  }
}
