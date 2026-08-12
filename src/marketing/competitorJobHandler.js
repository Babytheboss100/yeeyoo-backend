import { pool } from '../db.js'
import { getMarketingProfile } from './profileStore.js'
import { analyzeCompetitor, persistCompetitorAnalysis } from './competitorWorker.js'

export function createCompetitorJobHandler({ db = pool, crawler } = {}) {
  return async job => {
    const { competitorId } = job.input || {}
    const { rows } = await db.query('SELECT id,website_url FROM competitors WHERE id=$1 AND user_id=$2 AND project_id=$3', [competitorId, job.userId, job.projectId])
    if (!rows[0]) throw Object.assign(new Error('Competitor not found in job scope'), { code: 'COMPETITOR_NOT_FOUND', retryable: false })
    const profile = await getMarketingProfile({ userId: job.userId, projectId: job.projectId, db })
    const result = await analyzeCompetitor({ competitor: { websiteUrl: rows[0].website_url }, marketingProfile: profile, ...(crawler ? { crawler } : {}) })
    await persistCompetitorAnalysis({ userId: job.userId, projectId: job.projectId, competitorId, result, db })
    return { artifacts: [{ type: 'competitor-intelligence', competitorId, evidenceCount: result.evidence.length }] }
  }
}

