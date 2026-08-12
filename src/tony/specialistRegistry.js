export const SPECIALIST_CAPABILITIES = Object.freeze({
  marketing_audit: ['marketing_profile.read', 'audit.read'],
  brand: ['marketing_profile.read', 'brand.read'],
  competitors: ['marketing_profile.read', 'competitors.read'],
  copy: ['marketing_profile.read', 'copy.create_draft'],
  social: ['marketing_profile.read', 'planner.create_draft'],
  seo: ['marketing_profile.read', 'seo.read', 'seo.create_draft'],
  funnel: ['marketing_profile.read', 'funnel.create_draft'],
  launch: ['marketing_profile.read', 'launch.create_draft'],
  ads: ['marketing_profile.read', 'ads.create_draft'],
  reporting: ['marketing_profile.read', 'reporting.read'],
})

const FORBIDDEN = /(?:approve|publish|send|spend|connect|disconnect|delete)/i

export function createSpecialistRegistry(definitions = SPECIALIST_CAPABILITIES) {
  const registry = new Map(Object.entries(definitions).map(([name, tools]) => {
    if (!Array.isArray(tools) || tools.some((tool) => FORBIDDEN.test(tool))) throw new TypeError('Specialists may only read or create drafts')
    return [name, Object.freeze([...tools])]
  }))
  return Object.freeze({
    describe: () => [...registry].map(([name, tools]) => ({ name, tools: [...tools] })),
    toolsFor(name) { if (!registry.has(name)) throw new TypeError('Unknown specialist'); return [...registry.get(name)] },
    assertAllowed(name, tool) { if (!registry.get(name)?.includes(tool)) { const error = new Error('Specialist escalation denied'); error.code = 'SPECIALIST_PERMISSION_DENIED'; throw error } return true },
  })
}
