const GRAPH = 'https://graph.facebook.com/v21.0'
const DIALOG = 'https://www.facebook.com/v21.0/dialog/oauth'
const SCOPES = Object.freeze(['pages_show_list', 'instagram_basic'])

export class MetaConnectionError extends Error {
  constructor(code, message = 'Meta connection failed', status = 502) { super(message); this.code = code; this.status = status }
}

const configured = env => Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI && env.META_TOKEN_ENCRYPTION_KEY)

export function validateMetaConnectionConfig(env = process.env) {
  if (!configured(env)) throw new MetaConnectionError('META_CONFIG_MISSING', 'Meta connection is not configured', 503)
  if (String(env.META_TOKEN_ENCRYPTION_KEY).length < 32) throw new MetaConnectionError('META_ENCRYPTION_KEY_INVALID', 'Meta token encryption is not configured safely', 503)
  let redirect
  try { redirect = new URL(env.META_REDIRECT_URI) } catch { throw new MetaConnectionError('META_REDIRECT_INVALID', 'Meta redirect URI is invalid', 503) }
  if (redirect.protocol !== 'https:' || redirect.pathname !== '/api/oauth/meta/callback' || redirect.search || redirect.hash) throw new MetaConnectionError('META_REDIRECT_INVALID', 'Meta redirect URI is invalid', 503)
  return { redirectUri: redirect.toString(), scopes: [...SCOPES] }
}

async function request(url, options = {}, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data?.error) {
      const providerCode = Number(data?.error?.code)
      const code = response.status === 401 || providerCode === 190 ? 'REAUTH_REQUIRED' : response.status === 403 ? 'INSUFFICIENT_PERMISSION' : response.status === 429 || providerCode === 4 ? 'RATE_LIMITED' : 'PROVIDER_ERROR'
      throw new MetaConnectionError(code, 'Meta connection requires attention', response.status || 502)
    }
    return data
  } catch (error) {
    if (error instanceof MetaConnectionError) throw error
    if (error?.name === 'AbortError') throw new MetaConnectionError('PROVIDER_TIMEOUT', 'Meta connection timed out', 504)
    throw new MetaConnectionError('PROVIDER_UNAVAILABLE', 'Meta connection is temporarily unavailable', 503)
  } finally { clearTimeout(timer) }
}

export function createMetaConnectionProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = validateMetaConnectionConfig(env)
  return Object.freeze({
    mode: 'live', scopes: config.scopes,
    authorizationUrl({ state }) {
      const query = new URLSearchParams({ client_id: env.META_APP_ID, redirect_uri: config.redirectUri, state, response_type: 'code', scope: config.scopes.join(',') })
      return `${DIALOG}?${query}`
    },
    async exchange({ code }) {
      const body = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: config.redirectUri, code })
      const data = await request(`${GRAPH}/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, fetchImpl)
      if (!data.access_token) throw new MetaConnectionError('TOKEN_EXCHANGE_FAILED')
      return { accessToken: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null }
    },
    async identity({ accessToken }) {
      const data = await request(`${GRAPH}/me?fields=id,name`, { headers: { Authorization: `Bearer ${accessToken}` } }, fetchImpl)
      if (!data.id) throw new MetaConnectionError('IDENTITY_MISSING')
      return { id: String(data.id), name: typeof data.name === 'string' ? data.name.slice(0, 120) : null }
    },
    async discoverAccounts({ accessToken }) {
      const data = await request(`${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username,name}`, { headers: { Authorization: `Bearer ${accessToken}` } }, fetchImpl)
      const pages = Array.isArray(data.data) ? data.data.map(page => ({ id: String(page.id), name: String(page.name || '').slice(0, 120), instagramProfessionalAccount: page.instagram_business_account ? { id: String(page.instagram_business_account.id), username: String(page.instagram_business_account.username || '').slice(0, 120), name: String(page.instagram_business_account.name || '').slice(0, 120) } : null })) : []
      return { pages, mock: false }
    },
    normalizeError(error) { return { code: error?.code || 'PROVIDER_ERROR', message: 'Meta connection requires attention' } },
  })
}
