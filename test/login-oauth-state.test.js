import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeLoginOauthState, createLoginOauthState } from '../src/lib/loginOauthState.js'

test('login OAuth state is persisted as a digest with explicit expiry', async () => {
  let args
  const db = { query: async (_sql, params) => { args = params; return { rows: [] } } }
  const state = await createLoginOauthState('google', 'http://localhost:3000/auth/callback', db)
  assert.equal(args[1].length, 64)
  assert.notEqual(args[1], state)
  assert.equal(args[2], 'google')
  assert.ok(args[4] > new Date())
})

test('login OAuth state consumption is atomic and replay-safe', async () => {
  let consumed = false
  const db = { query: async (sql, params) => {
    assert.match(sql, /DELETE FROM login_oauth_states/)
    assert.match(sql, /expires_at > NOW\(\)/)
    assert.equal(params[1], 'vipps')
    if (consumed) return { rows: [] }
    consumed = true
    return { rows: [{ return_to: '/auth/callback' }] }
  } }
  assert.ok(await consumeLoginOauthState('vipps', 'secret-state', db))
  assert.equal(await consumeLoginOauthState('vipps', 'secret-state', db), null)
  assert.equal(await consumeLoginOauthState('google', null, db), null)
})
