import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { requireAdmin } from '../middleware/admin.js'
import { getAdminUsageSummary, getAIUsageSummary } from '../services/aiUsageLedger.js'

const r = Router()
r.use(auth)
r.get('/admin/summary', requireAdmin, async (req, res) => {
  try { res.json(await getAdminUsageSummary({ from: req.query.from, to: req.query.to })) }
  catch { res.status(500).json({ error: 'AI unit economics could not be loaded' }) }
})
r.get('/:projectId', async (req, res) => {
  try {
    await requireProject(req, req.params.projectId)
    const usage = await getAIUsageSummary({ userId: req.user.id, projectId: req.params.projectId, from: req.query.from, to: req.query.to })
    res.json({ projectId: req.params.projectId, usage })
  } catch (error) {
    if (!sendProjectError(res, error)) res.status(500).json({ error: 'AI usage could not be loaded' })
  }
})
export default r
