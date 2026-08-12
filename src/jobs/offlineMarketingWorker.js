import { createWorker } from './worker.js'
import { createCompetitorJobHandler } from '../marketing/competitorJobHandler.js'
import { createSpecialistJobHandler } from '../marketing/specialistJobHandler.js'

// Explicitly started by an approved worker process. Importing this module never
// starts network work or timers, which keeps API processes and tests deterministic.
export function createOfflineMarketingWorker({workerId,db,crawler}={}){
  return createWorker({workerId,db,handlers:{
    'marketing.competitor-analysis':createCompetitorJobHandler({db,crawler}),
    'marketing.social':createSpecialistJobHandler({kind:'social',db}),
    'marketing.email':createSpecialistJobHandler({kind:'email',db}),
    'marketing.ads':createSpecialistJobHandler({kind:'ads',db}),
  }})
}

