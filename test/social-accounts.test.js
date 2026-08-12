import test from 'node:test'
import assert from 'node:assert/strict'
import { accountNeedsReconnect } from '../src/lib/socialAccounts.js'

test('social account reconnect state rejects expired and malformed expiry', () => {
  const now = new Date('2026-08-12T12:00:00Z')
  assert.equal(accountNeedsReconnect({ expires_at: '2026-08-12T11:59:59Z' }, now), true)
  assert.equal(accountNeedsReconnect({ expires_at: 'not-a-date' }, now), true)
  assert.equal(accountNeedsReconnect({ expires_at: '2026-08-12T12:00:01Z' }, now), false)
  assert.equal(accountNeedsReconnect({}, now), false)
})
