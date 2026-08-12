import test from 'node:test'
import assert from 'node:assert/strict'
import { MetaGraphProvider, MetaProviderError, MockMetaProvider } from '../src/lib/metaProvider.js'

test('mock Meta provider covers publish, reply, failure and token expiry without network', async () => {
  const mock = new MockMetaProvider()
  assert.match((await mock.publishFacebook({})).id, /^mock-facebook/)
  assert.match((await mock.publishInstagram({})).id, /^mock-instagram/)
  assert.match((await mock.reply({})).id, /^mock-reply/)
  await assert.rejects(() => new MockMetaProvider({ fail: true }).publishFacebook({}), { code: 'mock_failure' })
  await assert.rejects(() => new MockMetaProvider({ expired: true }).reply({}), { code: 'token_expired', status: 401 })
})

test('Meta Graph adapter normalizes provider failures', async () => {
  const provider = new MetaGraphProvider({ fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'slow down', code: 4 } }) }) })
  await assert.rejects(() => provider.publishFacebook({ account: { page_id: 'p' }, accessToken: 'secret' }), (error) => {
    assert.ok(error instanceof MetaProviderError)
    assert.equal(error.code, 'meta_4')
    assert.equal(error.retryable, true)
    return true
  })
})

test('Meta Graph adapter does not expose token in URL', async () => {
  let request
  const provider = new MetaGraphProvider({ fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ id: 'ok' }) } } })
  await provider.publishFacebook({ account: { page_id: 'page' }, accessToken: 'top-secret', message: 'hello' })
  assert.doesNotMatch(request.url, /top-secret/)
  assert.equal(JSON.parse(request.options.body).access_token, 'top-secret')
})
