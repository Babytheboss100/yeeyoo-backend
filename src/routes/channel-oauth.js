import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { CHANNEL_PROVIDERS } from '../lib/channelProviderAdapters.js'
import { createChannelOAuthService } from '../lib/channelOAuthService.js'

const r = Router()
const service = createChannelOAuthService()
r.use(auth)
r.use(enforceProjectOwnership)

r.post('/:provider/start', async (req, res) => {
  const { provider } = req.params
  const { projectId, redirectUri } = req.body || {}
  if (!CHANNEL_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  if (!projectId || !redirectUri) return res.status(400).json({ error: 'projectId og redirectUri kreves' })
  try { res.json(await service.start({ userId: req.user.id, projectId, provider, redirectUri })) }
  catch (error) { res.status(400).json({ error: error.message }) }
})

r.post('/:provider/callback', async (req, res) => {
  const { provider } = req.params
  const { projectId, state, code } = req.body || {}
  if (!CHANNEL_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  try { res.json(await service.callback({ projectId, provider, state, code })) }
  catch (error) { res.status(error.code === 'INVALID_OAUTH_STATE' ? 409 : 400).json({ error: error.message, code: error.code }) }
})

export default r
