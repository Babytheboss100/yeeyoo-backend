import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANNEL_PROVIDERS, createMockChannelProviderAdapter } from '../src/lib/channelProviderAdapters.js'

test('all Phase 9 channel providers expose offline lifecycle contracts', () => {
  for (const provider of CHANNEL_PROVIDERS) {
    const adapter = createMockChannelProviderAdapter(provider, { id: () => `${provider}-state`, now: () => 'now' })
    const start = adapter.initiateOAuth({ projectId: 'p1', redirectUri: 'https://app.invalid/callback' })
    assert.equal(start.mock, true); assert.match(start.authorizationUrl, /^https:\/\/mock\.invalid\//)
    assert.equal(adapter.callback({ projectId: 'p1', state: start.state, code: 'sandbox' }).mock, true)
    assert.throws(() => adapter.callback({ projectId: 'p1', state: start.state, code: 'replay' }), { code: 'INVALID_OAUTH_STATE' })
  }
})

test('mock publish enforces project, approval and idempotency', () => {
  const adapter = createMockChannelProviderAdapter('meta')
  const connection = { id: 'conn', projectId: 'p1' }
  assert.throws(() => adapter.publish({ connection, artifact: { projectId: 'p2', status: 'approved' }, idempotencyKey: 'k' }), { code: 'PROJECT_SCOPE_MISMATCH' })
  assert.throws(() => adapter.publish({ connection, artifact: { projectId: 'p1', status: 'draft' }, idempotencyKey: 'k' }), { code: 'APPROVAL_REQUIRED' })
  assert.equal(adapter.publish({ connection, artifact: { projectId: 'p1', status: 'approved' }, idempotencyKey: 'k' }).providerPostId, 'mock:meta:k')
})

test('provider errors are normalized without token leakage', () => {
  const adapter = createMockChannelProviderAdapter('x')
  assert.deepEqual(adapter.normalizeError(new Error('secret-token')), { code: 'PROVIDER_ERROR', message: 'Provider request failed', retryable: false })
})
