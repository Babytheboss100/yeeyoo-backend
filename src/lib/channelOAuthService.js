import { CHANNEL_PROVIDERS, createMockChannelProviderAdapter } from './channelProviderAdapters.js'
import { createChannelOAuthState, consumeChannelOAuthState, getChannelConnection, getConnectionCredential, getOwnedOAuthStateContext, listChannelConnections, revokeChannelConnection, updateChannelConnectionVerification, upsertLiveChannelConnection, upsertMockChannelConnection } from './channelOAuthStore.js'
import { metaDiscoveryCapabilities, toChannelConnection } from './channelConnections.js'
import { createMetaConnectionProvider } from './metaConnectionProvider.js'

export function validateChannelOAuthRedirect(value, { frontendUrl = process.env.FRONTEND_URL, nodeEnv = process.env.NODE_ENV } = {}) {
  let candidate
  try { candidate = new URL(value) } catch { throw new TypeError('OAuth redirect URI is invalid') }
  if (!['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password || candidate.search || candidate.hash || candidate.pathname !== '/dashboard/connections') throw new TypeError('OAuth redirect URI is invalid')
  const allowed = new Set()
  try { allowed.add(new URL(frontendUrl).origin) } catch { /* configuration is checked below */ }
  if (nodeEnv !== 'production') for (const origin of ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000']) allowed.add(origin)
  if (!allowed.size) { const error = new Error('FRONTEND_URL is not configured'); error.code = 'OAUTH_CONFIG_ERROR'; throw error }
  if (!allowed.has(candidate.origin)) { const error = new Error('OAuth redirect origin is not allowed'); error.code = 'OAUTH_REDIRECT_NOT_ALLOWED'; throw error }
  return candidate.toString()
}

export function createChannelOAuthService({ db, frontendUrl, nodeEnv, adapters } = {}) {
  if(!adapters){adapters=Object.fromEntries(CHANNEL_PROVIDERS.map((p)=>[p,createMockChannelProviderAdapter(p)]));if(process.env.META_CONNECTION_MODE==='live')adapters.meta=createMetaConnectionProvider()}
  return Object.freeze({
    async start({ userId, projectId, provider, redirectUri }) {
      const adapter = adapters[provider]
      if (!adapter) throw new TypeError('Provider is unavailable')
      const safeRedirectUri = validateChannelOAuthRedirect(redirectUri, { frontendUrl:frontendUrl ?? process.env.FRONTEND_URL, nodeEnv:nodeEnv ?? process.env.NODE_ENV })
      const state = await createChannelOAuthState({ userId, projectId, provider, redirectUri: safeRedirectUri, db })
      const mock=adapter.mode!=='live'
      return { authorizationUrl: mock?`https://mock.invalid/${provider}/authorize?state=${encodeURIComponent(state)}`:adapter.authorizationUrl({state}), ...(mock?{state}:{}), provider, mock }
    },
    async callback({ userId, projectId, provider, state, code, error: providerError }) {
      if (providerError) { const error = new Error('OAuth provider denied or failed the request'); error.code = 'OAUTH_PROVIDER_ERROR'; throw error }
      if (!code) throw new TypeError('OAuth code is required')
      const consumed = await consumeChannelOAuthState({ state, userId, projectId, provider, db })
      if (!consumed) { const error = new Error('OAuth state is invalid, expired, or already used'); error.code = 'INVALID_OAUTH_STATE'; throw error }
      const row = await upsertMockChannelConnection({ userId: consumed.user_id, projectId, provider, externalAccountId: `mock:${provider}:${projectId}`, scopes: provider==='meta'?['pages_show_list','instagram_basic']:[], db })
      return { connection: toChannelConnection({ ...row, active: row.status !== 'revoked' }, provider), mock: true }
    },
    async callbackFromProvider({userId,provider='meta',state,code,error:providerError}){
      if(providerError){const error=new Error('OAuth provider denied or failed the request');error.code='OAUTH_PROVIDER_ERROR';throw error}
      if(!code||!state)throw Object.assign(new Error('OAuth callback is incomplete'),{code:'OAUTH_CALLBACK_INVALID'})
      const context=await getOwnedOAuthStateContext({state,userId,provider,db});if(!context)throw Object.assign(new Error('OAuth state is invalid, expired, or already used'),{code:'INVALID_OAUTH_STATE'})
      const consumed=await consumeChannelOAuthState({state,userId,projectId:context.project_id,provider,db});if(!consumed)throw Object.assign(new Error('OAuth state is invalid, expired, or already used'),{code:'INVALID_OAUTH_STATE'})
      const adapter=adapters[provider];if(adapter?.mode!=='live')throw Object.assign(new Error('Meta live adapter is not enabled'),{code:'META_LIVE_DISABLED'})
      const token=await adapter.exchange({code});const identity=await adapter.identity({accessToken:token.accessToken})
      const row=await upsertLiveChannelConnection({userId,projectId:context.project_id,provider,externalAccountId:identity.id,scopes:adapter.scopes,accessToken:token.accessToken,expiresAt:token.expiresAt,db})
      return {connection:toChannelConnection({...row,active:true},provider),projectId:context.project_id}
    },
    async list({ userId, projectId }) {
      const rows = await listChannelConnections({ userId, projectId, db })
      return { connections: rows.map(row => toChannelConnection({ ...row, active: row.status !== 'revoked' }, row.provider)) }
    },
    async revoke({ id, userId, projectId }) {
      const row = await revokeChannelConnection({ id, userId, projectId, db })
      if (!row) { const error = new Error('Connection not found'); error.code = 'NOT_FOUND'; throw error }
      return { connection: toChannelConnection({ ...row, active: false }, row.provider), mock: true }
    },
    async disconnectMeta({id,userId,projectId}){
      const existing=await getChannelConnection({id,userId,projectId,provider:'meta',db})
      if(!existing){const error=new Error('Connection not found');error.code='NOT_FOUND';throw error}
      adapters.meta.disconnect({connection:toChannelConnection({...existing,active:true},'meta')})
      return this.revoke({id,userId,projectId})
    },
    async reconnect({ id,userId,projectId,redirectUri }) {
      const row=await getChannelConnection({id,userId,projectId,provider:'meta',db})
      if(!row){const error=new Error('Connection not found');error.code='NOT_FOUND';throw error}
      return this.start({userId,projectId,provider:'meta',redirectUri})
    },
    async discoverMeta({ id,userId,projectId }) {
      const row=await getChannelConnection({id,userId,projectId,provider:'meta',db})
      if(!row){const error=new Error('Connection not found');error.code='NOT_FOUND';throw error}
      if(row.status==='revoked'){const error=new Error('Connection requires reconnect');error.code='RECONNECT_REQUIRED';throw error}
      const adapter=adapters.meta
      try{
        const credential=adapter.mode==='live'?await getConnectionCredential({connectionId:id,userId,projectId,db}):null
        if(adapter.mode==='live'&&!credential)throw Object.assign(new Error('Connection requires reconnect'),{code:'RECONNECT_REQUIRED'})
        const result=await adapter.discoverAccounts({connection:toChannelConnection({...row,active:true},'meta'),accessToken:credential?.accessToken})
        const capabilities=metaDiscoveryCapabilities({scopes:row.scopes,connected:true,pages:result.pages})
        await updateChannelConnectionVerification({id,userId,projectId,capabilities,db})
        return {pages:result.pages,capabilities,mock:adapter.mode==='mock'}
      }catch(error){
        const normalized=adapter.normalizeError(error);const reconnect=normalized.code==='token_expired'||normalized.code==='invalid_token'
        await updateChannelConnectionVerification({id,userId,projectId,status:reconnect?'reconnect_required':'error',capabilities:metaDiscoveryCapabilities({scopes:row.scopes}),errorCode:normalized.code,db})
        throw Object.assign(new Error(normalized.message),normalized)
      }
    },
  })
}
