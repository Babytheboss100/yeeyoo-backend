import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  consumeExchangeCode,
  createExchangeCode,
  createSession,
  findSession,
  revokeSession,
  setSessionCookies,
} from '../src/lib/session.js'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

test('session creation stores only token digests with explicit expiry', async () => {
  let statement
  let params
  const client = { query: async (sql, values) => { statement = sql; params = values; return { rows: [] } } }
  const session = await createSession('user-1', { headers: { 'user-agent': 'test' }, ip: '127.0.0.1' }, client)

  assert.notEqual(session.accessToken, session.refreshToken)
  assert.equal(params[2], sha256(session.accessToken))
  assert.equal(params[3], sha256(session.refreshToken))
  assert.doesNotMatch(statement, /\$3[^\n]*accessToken/i)
  assert.match(statement, /INTERVAL '15 minutes'/)
  assert.match(statement, /INTERVAL '30 days'/)
  assert.equal(params.includes(session.accessToken), false)
  assert.equal(params.includes(session.refreshToken), false)
})

test('session cookies are HttpOnly, scoped, SameSite and secure in production', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const writes = []
  const clears = []
  const headers = []
  const res = {
    cookie: (...args) => writes.push(args),
    clearCookie: (...args) => clears.push(args),
    set: (...args) => headers.push(args),
  }
  try {
    setSessionCookies(res, { accessToken: 'access', refreshToken: 'refresh' })
    clearSessionCookies(res)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }

  assert.deepEqual(writes.map(([name]) => name), [ACCESS_COOKIE, REFRESH_COOKIE])
  for (const [, , options] of writes) {
    assert.equal(options.httpOnly, true)
    assert.equal(options.secure, true)
    assert.equal(options.sameSite, 'lax')
    assert.equal(options.path, '/')
    assert.ok(options.maxAge > 0)
  }
  assert.deepEqual(clears.map(([name]) => name), [ACCESS_COOKIE, REFRESH_COOKIE])
  assert.ok(headers.some(([name, value]) => name === 'Cache-Control' && value === 'no-store'))
})

test('exchange codes are single-use and expired codes cannot create sessions', async () => {
  const active = new Map()
  const users = new Map([['user-1', { id: 'user-1', name: 'Test', email: 'test@example.com', is_admin: false }]])
  const client = {
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] }
      if (sql.includes('INSERT INTO auth_exchange_codes')) { active.set(params[2], { userId: params[1], expired: false }); return { rows: [] } }
      if (sql.includes('DELETE FROM auth_exchange_codes')) {
        const item = active.get(params[0])
        if (!item || item.expired) return { rows: [] }
        active.delete(params[0])
        return { rows: [{ user_id: item.userId }] }
      }
      if (sql.includes('INSERT INTO auth_sessions')) return { rows: [] }
      if (sql.includes('SELECT id,name,email,is_admin FROM users')) return { rows: [users.get(params[0])] }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const db = { connect: async () => client }
  const exchangeClient = { query: client.query.bind(client) }
  const code = await createExchangeCode('user-1', exchangeClient)
  const request = { headers: {}, ip: '127.0.0.1' }

  assert.equal((await consumeExchangeCode(code, request, db)).user.id, 'user-1')
  assert.equal(await consumeExchangeCode(code, request, db), null)

  const expired = await createExchangeCode('user-1', exchangeClient)
  active.get(sha256(expired)).expired = true
  assert.equal(await consumeExchangeCode(expired, request, db), null)
})

test('revocation hashes credentials and revoked/expired lookup is fail-closed', async () => {
  let revokeParams, revokeSql
  await revokeSession({ accessToken: 'access', refreshToken: 'refresh' }, {
    query: async (sql, params) => { revokeSql = sql; revokeParams = params; return { rows: [] } },
  })
  assert.deepEqual(revokeParams[0], [sha256('access'), sha256('refresh')])
  assert.match(revokeSql,/matched_families/)
  assert.match(revokeSql,/family_id IN/)

  let lookupSql
  const found = await findSession('access', {
    query: async (sql) => { lookupSql = sql; return { rows: [] } },
  })
  assert.equal(found, null)
  assert.match(lookupSql, /revoked_at IS NULL/)
  assert.match(lookupSql, /access_expires_at > NOW\(\)/)
})

test('auth callbacks exchange one-time codes without leaking JWTs in URLs', () => {
  const source = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8')
  const executable = source.replace(/\/\/.*$/gm, '')
  assert.match(source, /createExchangeCode/)
  assert.match(source, /new URLSearchParams\(\{\s*code,/)
  assert.doesNotMatch(executable, /[?&](?:oauth_)?token=/)
  assert.doesNotMatch(executable, /sessionStorage/)
  assert.match(source, /consumeLoginOauthState\('(?:google|vipps)', state\)/)
  assert.doesNotMatch(source, /const pendingStates = new Map/)
})
