import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { CHANNEL_PROVIDERS } from '../lib/channelProviderAdapters.js'
import { createChannelOAuthService } from '../lib/channelOAuthService.js'
import { recordProjectActivity } from '../lib/projectActivity.js'

const r = Router()
const service = createChannelOAuthService()
const activity = input => recordProjectActivity(input).catch(() => null)
r.use(auth)
r.use(enforceProjectOwnership)

r.get('/', async (req, res) => {
  try { res.json(await service.list({ userId:req.user.id, projectId:req.query.projectId })) }
  catch (error) { res.status(400).json({ error:error.message }) }
})

r.post('/:provider/start', async (req, res) => {
  const { provider } = req.params
  const { projectId, redirectUri } = req.body || {}
  if (!CHANNEL_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  if (!projectId || !redirectUri) return res.status(400).json({ error: 'projectId og redirectUri kreves' })
  try { const result=await service.start({ userId: req.user.id, projectId, provider, redirectUri }); if(provider==='meta') await activity({userId:req.user.id,projectId,eventType:'meta_connection_initiated',subjectType:'channel_connection',summary:'Meta connection initiated',metadata:{provider:'meta'},dedupeKey:`meta:start:${projectId}:${Date.now()}`}); res.json(result) }
  catch (error) { res.status(400).json({ error: error.message }) }
})

r.post('/:provider/callback', async (req, res) => {
  const { provider } = req.params
  const { projectId, state, code, error } = req.body || {}
  if (!CHANNEL_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Ukjent provider' })
  try { const result=await service.callback({ userId:req.user.id, projectId, provider, state, code, error }); if(provider==='meta') await activity({userId:req.user.id,projectId,eventType:'meta_connection_completed',subjectType:'channel_connection',subjectId:result.connection?.id,summary:'Meta connection completed',metadata:{provider:'meta'},dedupeKey:`meta:connected:${result.connection?.id}`}); res.json(result) }
  catch (error) { res.status(error.code === 'INVALID_OAUTH_STATE' ? 409 : 400).json({ error: error.message, code: error.code }) }
})

r.post('/:provider/:id/revoke', async (req, res) => {
  const { provider, id } = req.params
  if (!CHANNEL_PROVIDERS.includes(provider)) return res.status(400).json({ error:'Ukjent provider' })
  try { const projectId=req.body?.projectId; const result=await service.revoke({ id,userId:req.user.id,projectId }); if(provider==='meta') await activity({userId:req.user.id,projectId,eventType:'provider_disconnected',subjectType:'channel_connection',subjectId:id,summary:'Meta connection revoked',metadata:{provider:'meta'},dedupeKey:`meta:revoked:${id}`}); res.json(result) }
  catch (error) { res.status(error.code === 'NOT_FOUND' ? 404 : 400).json({ error:error.message,code:error.code }) }
})

r.get('/meta/:id/discover',async(req,res)=>{const projectId=req.query.projectId;try{const result=await service.discoverMeta({id:req.params.id,userId:req.user.id,projectId});await activity({userId:req.user.id,projectId,eventType:'meta_capability_verified',subjectType:'channel_connection',subjectId:req.params.id,summary:'Meta capabilities verified',metadata:{provider:'meta',pageCount:result.pages?.length||0},dedupeKey:`meta:verified:${req.params.id}:${new Date().toISOString().slice(0,10)}`});res.json(result)}catch(error){if(error.code==='RECONNECT_REQUIRED')await activity({userId:req.user.id,projectId,eventType:'meta_reauth_required',subjectType:'channel_connection',subjectId:req.params.id,summary:'Meta reconnection required',metadata:{provider:'meta'},dedupeKey:`meta:reauth:${req.params.id}`});res.status(error.code==='NOT_FOUND'?404:error.code==='RECONNECT_REQUIRED'?409:502).json({error:error.message,code:error.code})}})
r.post('/meta/:id/reconnect',async(req,res)=>{try{res.json(await service.reconnect({id:req.params.id,userId:req.user.id,projectId:req.body?.projectId,redirectUri:req.body?.redirectUri}))}catch(error){res.status(error.code==='NOT_FOUND'?404:400).json({error:error.message,code:error.code})}})
r.post('/meta/:id/disconnect',async(req,res)=>{const projectId=req.body?.projectId;try{const result=await service.disconnectMeta({id:req.params.id,userId:req.user.id,projectId});await activity({userId:req.user.id,projectId,eventType:'provider_disconnected',subjectType:'channel_connection',subjectId:req.params.id,summary:'Meta connection disconnected',metadata:{provider:'meta'},dedupeKey:`meta:disconnected:${req.params.id}`});res.json(result)}catch(error){res.status(error.code==='NOT_FOUND'?404:400).json({error:error.message,code:error.code})}})

export default r
