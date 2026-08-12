import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject } from '../middleware/project.js'
import { listProjectActivity } from '../lib/projectActivity.js'

const r = Router()
r.get('/:projectId', auth, async (req, res) => {
  try {
    await requireProject(req, req.params.projectId)
    const items = await listProjectActivity({ userId:req.user.id, projectId:req.params.projectId, limit:req.query.limit, before:req.query.before })
    res.json({ items })
  } catch (error) {
    res.status(error.status || 500).json({ error:error.message })
  }
})
export default r
