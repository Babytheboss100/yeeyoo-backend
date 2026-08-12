import { CHANNEL_PROVIDERS, createMockChannelProviderAdapter } from './channelProviderAdapters.js'
import { createChannelOAuthState, consumeChannelOAuthState, upsertMockChannelConnection } from './channelOAuthStore.js'
import { toChannelConnection } from './channelConnections.js'

export function createChannelOAuthService({ db, adapters = Object.fromEntries(CHANNEL_PROVIDERS.map((p) => [p, createMockChannelProviderAdapter(p)])) } = {}) {
  return Object.freeze({
    async start({ userId, projectId, provider, redirectUri }) {
      const adapter = adapters[provider]
      if (!adapter || adapter.mode !== 'mock') throw new TypeError('Only approved mock providers are available')
      const state = await createChannelOAuthState({ userId, projectId, provider, redirectUri, db })
      return { authorizationUrl: `https://mock.invalid/${provider}/authorize?state=${encodeURIComponent(state)}`, state, provider, mock: true }
    },
    async callback({ projectId, provider, state, code }) {
      if (!code) throw new TypeError('OAuth code is required')
      const consumed = await consumeChannelOAuthState({ state, projectId, provider, db })
      if (!consumed) { const error = new Error('OAuth state is invalid, expired, or already used'); error.code = 'INVALID_OAUTH_STATE'; throw error }
      const row = await upsertMockChannelConnection({ userId: consumed.user_id, projectId, provider, externalAccountId: `mock:${provider}:${projectId}`, scopes: [], db })
      return { connection: toChannelConnection({ ...row, active: row.status !== 'revoked' }, provider), mock: true }
    },
  })
}
