const clean = value => String(value ?? '').trim()

export function createLaunchPlan(input, context = {}) {
  const name = clean(input.name)
  if (!name) throw new Error('name is required')
  const children = Array.isArray(context.artifacts) ? context.artifacts : []
  if (!children.length) throw new Error('at least one child artifact is required')
  if (children.some(item => item.projectId !== input.projectId || item.userId !== input.userId)) {
    const error = new Error('Child artifact is outside launch scope'); error.code = 'PROJECT_ACCESS_DENIED'; throw error
  }
  return {
    schemaVersion: 1, kind: 'launch', name, mode: 'deterministic-offline-draft', executable: false,
    childArtifacts: children.map(item => ({ id: item.id, rootId: item.rootId || item.id, artifactVersion: item.artifactVersion, type: item.type, status: item.status })),
    readiness: children.map(item => ({ artifactId: item.id, ready: item.status === 'approved', reason: item.status === 'approved' ? null : 'Artifact requires approval' })),
    phases: ['prepare', 'review', 'approve', 'schedule', 'measure'].map((phase, index) => ({ order: index + 1, phase, status: 'draft' })),
    provenance: { marketingProfileVersion: context.profile?.version ?? null, sourceArtifactIds: children.map(item => item.id) },
  }
}
