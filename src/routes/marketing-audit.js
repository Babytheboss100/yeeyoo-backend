import crypto from 'crypto'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { getMarketingProfile } from '../marketing/profileStore.js'
import { normalizePublicWebsiteUrl } from '../marketing/websiteUrl.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

// Local/profile adapter only: no crawler or provider is contacted in Phase 4.
r.post('/', async (req, res) => {
  const { projectId, websiteUrl } = req.body || {}
  if (!projectId || !websiteUrl) return res.status(400).json({ error: 'projectId og websiteUrl kreves' })
  let normalized
  try { normalized = normalizePublicWebsiteUrl(websiteUrl) } catch { return res.status(400).json({ error: 'Ugyldig websiteUrl' }) }
  const profile = await getMarketingProfile({ userId: req.user.id, projectId })
  res.status(201).json({ schema: 'yeeyoo.marketing-audit', version: 1, id: crypto.randomUUID(), projectId, websiteUrl: normalized, status: 'completed', provider: 'local-profile-adapter', profile })
})

export default r
