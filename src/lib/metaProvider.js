const DEFAULT_TIMEOUT_MS = 10_000

export class MetaProviderError extends Error {
  constructor(message, { code = 'provider_error', status = 502, retryable = false } = {}) {
    super(message)
    this.name = 'MetaProviderError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

export class MetaGraphProvider {
  constructor({ fetchImpl = globalThis.fetch, graphBase = 'https://graph.facebook.com/v21.0', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.fetch = fetchImpl
    this.graphBase = graphBase
    this.timeoutMs = timeoutMs
  }

  async request(path, accessToken, payload) {
    let response
    try {
      response = await this.fetch(`${this.graphBase}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, access_token: accessToken }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new MetaProviderError(error?.name === 'TimeoutError' ? 'Meta request timed out' : 'Meta provider unavailable', {
        code: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', retryable: true,
      })
    }
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new MetaProviderError(data?.error?.message || `Meta API ${response.status}`, {
        code: data?.error?.code ? `meta_${data.error.code}` : 'provider_error',
        status: response.status === 401 ? 401 : 502,
        retryable: response.status === 429 || response.status >= 500,
      })
    }
    return data
  }

  async publishFacebook({ account, accessToken, message, link, imageUrl }) {
    const path = imageUrl ? `${account.page_id}/photos` : `${account.page_id}/feed`
    const payload = imageUrl ? { url: imageUrl, caption: message || '' } : { message: message || '', ...(link ? { link } : {}) }
    const data = await this.request(path, accessToken, payload)
    return { id: data.post_id || data.id || null, raw: data }
  }

  async publishInstagram({ account, accessToken, imageUrl, caption }) {
    const created = await this.request(`${account.ig_user_id}/media`, accessToken, { image_url: imageUrl, caption: caption || '' })
    if (!created.id) throw new MetaProviderError('Meta returned no media container', { code: 'invalid_response' })
    const published = await this.request(`${account.ig_user_id}/media_publish`, accessToken, { creation_id: created.id })
    if (!published.id) throw new MetaProviderError('Meta returned no published media id', { code: 'invalid_response' })
    return { id: published.id, containerId: created.id, raw: published }
  }

  async reply({ account, platform, recipientId, text, accessToken }) {
    const sendId = platform === 'instagram' ? (account.ig_user_id || account.page_id) : account.page_id
    const data = await this.request(`${sendId}/messages`, accessToken, {
      recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE',
    })
    return { id: data.message_id || null, raw: data }
  }
}

export class MockMetaProvider {
  constructor({ fail = false, expired = false } = {}) { this.fail = fail; this.expired = expired; this.calls = [] }
  result(kind, input) {
    this.calls.push({ kind, input })
    if (this.expired) throw new MetaProviderError('Meta token expired', { code: 'token_expired', status: 401 })
    if (this.fail) throw new MetaProviderError('Mock Meta failure', { code: 'mock_failure', retryable: true })
    return { id: `mock-${kind}-${this.calls.length}`, mock: true }
  }
  async publishFacebook(input) { return this.result('facebook', input) }
  async publishInstagram(input) { return this.result('instagram', input) }
  async reply(input) { return this.result('reply', input) }
}

let provider
export function getMetaProvider() {
  if (!provider) provider = process.env.META_PROVIDER_MODE === 'live' ? new MetaGraphProvider() : new MockMetaProvider()
  return provider
}

export function setMetaProviderForTest(value) { provider = value }
