import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { getMarketingProfile, saveMarketingProfile } from '../marketing/profileStore.js'

const r = Router()
r.use(auth)

r.get('/:projectId', async (req, res) => {
  try {
    await requireProject(req, req.params.projectId)
    res.json(await getMarketingProfile({ userId: req.user.id, projectId: req.params.projectId }))
  } catch (error) { if (!sendProjectError(res, error)) res.status(500).json({ error: 'Kunne ikke hente marketingprofil' }) }
})

r.put('/:projectId', async (req, res) => {
  try {
    await requireProject(req, req.params.projectId)
    const profile = await saveMarketingProfile({ userId: req.user.id, projectId: req.params.projectId, profile: req.body || {}, source: 'api' })
    res.json(profile)
  } catch (error) { if (!sendProjectError(res, error)) res.status(500).json({ error: 'Kunne ikke lagre marketingprofil' }) }
})

export default r
