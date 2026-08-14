import crypto from 'node:crypto'
import { connectionCapabilities } from './channelConnections.js'

export const CHANNEL_PROVIDERS = Object.freeze(['meta', 'linkedin', 'pinterest', 'reddit', 'threads', 'x'])

export class ChannelProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'ChannelProviderError'; this.code = code; this.retryable = retryable }
}

const requireProvider = provider => {
  if (!CHANNEL_PROVIDERS.includes(provider)) throw new ChannelProviderError('UNSUPPORTED_PROVIDER', 'Unsupported channel provider')
}

// Offline contract adapter. It deliberately cannot accept a live transport.
// Replace through this interface when sandbox credentials are approved.
export function createMockChannelProviderAdapter(provider, { now = () => new Date().toISOString(), id = crypto.randomUUID, metaPages, discoveryError = null } = {}) {
  requireProvider(provider)
  const sessions = new Map()
  return Object.freeze({
    provider,
    mode: 'mock',
    capabilities: connectionCapabilities(provider),
    initiateOAuth({ projectId, redirectUri }) {
      if (!projectId || !redirectUri) throw new ChannelProviderError('INVALID_OAUTH_REQUEST', 'projectId and redirectUri are required')
      const state = id(); sessions.set(state, { projectId, used: false })
      return { state, authorizationUrl: `https://mock.invalid/${provider}/authorize?state=${encodeURIComponent(state)}`, mock: true }
    },
    callback({ projectId, state, code }) {
      const session = sessions.get(state)
      if (!session || session.projectId !== projectId || session.used || !code) throw new ChannelProviderError('INVALID_OAUTH_STATE', 'OAuth state is invalid or already used')
      session.used = true
      return { externalAccountId: `mock:${provider}:${projectId}`, displayName: `${provider} sandbox`, expiresAt: null, scopes: provider === 'meta' ? ['pages_show_list','instagram_basic'] : [], mock: true }
    },
    discoverAccounts({ connection }) {
      if (provider !== 'meta') throw new ChannelProviderError('CAPABILITY_UNAVAILABLE', 'Account discovery is unavailable')
      if (!connection?.id) throw new ChannelProviderError('CONNECTION_REQUIRED', 'Connection is required')
      if (discoveryError) throw discoveryError
      return { pages: metaPages || [{ id:'mock-page-1', name:'Mock Facebook Page', instagramProfessionalAccount:{ id:'mock-ig-1', username:'mock_business' } }], mock:true }
    },
    refresh({ connection }) {
      if (!connection?.id) throw new ChannelProviderError('CONNECTION_REQUIRED', 'Connection is required')
      return { status: 'connected', refreshedAt: now(), mock: true }
    },
    reconnect(input) { return this.initiateOAuth(input) },
    disconnect({ connection }) {
      if (!connection?.id) throw new ChannelProviderError('CONNECTION_REQUIRED', 'Connection is required')
      return { status: 'revoked', disconnectedAt: now(), mock: true }
    },
    publish({ connection, artifact, idempotencyKey }) {
      if (!this.capabilities.publish) throw new ChannelProviderError('CAPABILITY_UNAVAILABLE', 'Publishing is unavailable')
      if (!connection?.id || connection.projectId !== artifact?.projectId) throw new ChannelProviderError('PROJECT_SCOPE_MISMATCH', 'Connection and artifact must share project scope')
      if (artifact.status !== 'approved') throw new ChannelProviderError('APPROVAL_REQUIRED', 'Only approved artifacts can publish')
      if (!idempotencyKey) throw new ChannelProviderError('IDEMPOTENCY_REQUIRED', 'idempotencyKey is required')
      return { provider, providerPostId: `mock:${provider}:${idempotencyKey}`, status: 'published', mock: true }
    },
    normalizeError(error) {
      const code=error?.code||'PROVIDER_ERROR'
      const safe={token_expired:'Provider authorization expired',invalid_token:'Provider authorization is invalid',CAPABILITY_UNAVAILABLE:'Provider capability is unavailable'}
      return { code, message:safe[code] || (error instanceof ChannelProviderError ? error.message : 'Provider request failed'), retryable:error?.retryable===true }
    },
  })
}
