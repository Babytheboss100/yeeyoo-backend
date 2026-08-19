import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { createGetMediaInsightsHandler, MediaInsightsError } from '../mediaEngine/genome/insights.js'

function sendError(res, error) {
  if (sendProjectError(res, error)) return
  if (error instanceof MediaInsightsError) {
    res.status(error.status).json({ error: error.message, code: error.code })
    return
  }
  console.error('[media-insights] query failed')
  res.status(500).json({ error: 'Media insights could not be loaded', code: 'MEDIA_INSIGHTS_FAILED' })
}

export function createMediaInsightsRouter({ db, authMiddleware = auth, requireProjectImpl = requireProject } = {}) {
  const router = Router()
  router.use(authMiddleware)
  router.get('/', createGetMediaInsightsHandler({ db, requireProjectImpl, sendErrorImpl: sendError }))
  return router
}

export default createMediaInsightsRouter
