import test from 'node:test'
import assert from 'node:assert/strict'
import { sendSafeError } from '../src/lib/safeError.js'

// Audit HØY-2: rå e.message gikk til klient i 112 endepunkter. Helperen
// slipper KUN app-mintede feil gjennom — alt annet blir generisk 500.

function fakeRes() {
  const r = { statusCode: null, body: null }
  r.status = c => { r.statusCode = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}

test('app-mintet feil (status + SCREAMING_SNAKE code) slipper gjennom', () => {
  const res = fakeRes()
  sendSafeError(res, Object.assign(new Error('Voice turn was already processed'), { code: 'VOICE_TURN_REPLAY', status: 409 }))
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'VOICE_TURN_REPLAY')
})

test('pg-feil maskeres: melding, SQLSTATE og tabellnavn når aldri klienten', () => {
  const res = fakeRes()
  const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505', table: 'users' })
  sendSafeError(res, pgErr, 'auth')
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error, 'Internal server error')
  assert.ok(!JSON.stringify(res.body).includes('users'))
  assert.ok(!JSON.stringify(res.body).includes('23505'))
})

test('numerisk status uten app-kode maskeres (pg-koder er ikke autoritet)', () => {
  const res = fakeRes()
  sendSafeError(res, Object.assign(new Error('boom'), { status: 400, code: '42703' }))
  assert.equal(res.statusCode, 500)
})

test('kode uten status maskeres, TypeError maskeres, null maskeres', () => {
  for (const e of [Object.assign(new Error('x'), { code: 'SOME_CODE' }), new TypeError('cannot read'), null]) {
    const res = fakeRes()
    sendSafeError(res, e)
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.error, 'Internal server error')
  }
})

test('status utenfor [400,600) maskeres', () => {
  const res = fakeRes()
  sendSafeError(res, Object.assign(new Error('redirect?'), { code: 'WEIRD', status: 302 }))
  assert.equal(res.statusCode, 500)
})
