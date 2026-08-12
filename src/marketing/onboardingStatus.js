export const ONBOARDING_STEPS = Object.freeze(['project','marketing-profile','brand','competitors','connections','tony'])

// Status is evidence-based: optional/external steps are never reported complete
// unless persisted state confirms completion.
export function buildOnboardingStatus({ project = null, profile = null, brand = null, competitors = [], connections = [], tonyPlans = [] } = {}) {
  const steps = {
    project: { required:true, status:project ? 'completed' : 'pending' },
    'marketing-profile': { required:true, status:profile ? 'completed' : project ? 'ready' : 'blocked' },
    brand: { required:true, status:brand ? 'completed' : profile ? 'ready' : 'blocked' },
    competitors: { required:false, status:competitors.some(item => item.status === 'analyzed') ? 'completed' : project ? 'available' : 'blocked' },
    connections: { required:false, status:connections.some(item => item.status === 'connected') ? 'completed' : project ? 'available' : 'blocked' },
    tony: { required:false, status:tonyPlans.length ? 'completed' : profile ? 'ready' : 'blocked' },
  }
  const requiredComplete = Object.values(steps).filter(step => step.required).every(step => step.status === 'completed')
  return { schemaVersion:1, projectId:project?.id || null, requiredComplete, steps }
}

