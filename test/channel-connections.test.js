import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionCapabilities, connectionStatus, toChannelConnection } from '../src/lib/channelConnections.js'

test('channel connection exposes provider capability truthfully', () => {
  assert.equal(connectionCapabilities('mailchimp').campaigns, true)
  assert.equal(connectionCapabilities('klaviyo').campaigns, false)
  assert.deepEqual(connectionCapabilities('unknown'), { contactsSync: false, campaigns: false, publish: false, inbox: false })
})

test('channel status handles expiry, provider errors and revocation', () => {
  const now = new Date('2026-08-12T12:00:00Z')
  assert.equal(connectionStatus({ active: true, expires_at: '2026-08-12T11:00:00Z' }, now), 'reconnect_required')
  assert.equal(connectionStatus({ active: true, last_error: 'secret provider detail' }, now), 'error')
  assert.equal(connectionStatus({ active: false }, now), 'revoked')
})

test('canonical connection never leaks provider credentials or raw errors', () => {
  const connection = toChannelConnection({ id: 'i1', project_id: 'p1', active: true, api_key: 'secret', access_token: 'secret-2', last_error: 'credential leaked' }, 'mailchimp')
  assert.equal(connection.projectId, 'p1')
  assert.equal(connection.error.message, 'Provider connection requires attention')
  assert.equal('apiKey' in connection, false)
  assert.equal(JSON.stringify(connection).includes('secret'), false)
})

