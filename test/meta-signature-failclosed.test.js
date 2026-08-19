import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { verifyMetaSignature } from '../src/lib/whatsapp.js'

// SECURITY_AUDIT_2026-08-19.md MEDIUM-1: manglende META_APP_SECRET ga
// `return process.env.NODE_ENV !== 'production'`, altså aksept av usignerte
// payloads i alt som ikke var produksjon.

const withEnv = (value, fn) => {
  const had = Object.hasOwn(process.env, 'META_APP_SECRET')
  const previous = process.env.META_APP_SECRET
  const hadNode = process.env.NODE_ENV
  try { if (value === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = value; return fn() }
  finally {
    if (had) process.env.META_APP_SECRET = previous; else delete process.env.META_APP_SECRET
    process.env.NODE_ENV = hadNode
  }
}

test('manglende secret avviser, uansett miljø', () => {
  for (const env of ['test', 'development', 'staging', 'production', undefined]) {
    withEnv(undefined, () => {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env
      assert.equal(verifyMetaSignature(Buffer.from('{}'), 'sha256=deadbeef'), false, `NODE_ENV=${env} må avvise`)
      assert.equal(verifyMetaSignature(Buffer.from('{}'), null), false, `NODE_ENV=${env} må avvise uten header`)
    })
  }
})

test('gyldig signatur godtas, forfalsket avvises', () => {
  const secret = 'test-app-secret-not-a-real-credential'
  const body = Buffer.from(JSON.stringify({ entry: [{ id: '1' }] }))
  const valid = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  withEnv(secret, () => {
    assert.equal(verifyMetaSignature(body, valid), true)
    assert.equal(verifyMetaSignature(body, 'sha256=' + '0'.repeat(64)), false)
    assert.equal(verifyMetaSignature(Buffer.from('{"tampered":true}'), valid), false)
    assert.equal(verifyMetaSignature(body, 'kort'), false, 'ulik lengde må ikke kaste')
  })
})

test('fail-open-grenen finnes ikke lenger i kilden', () => {
  const source = fs.readFileSync(new URL('../src/lib/whatsapp.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /return process\.env\.NODE_ENV !== 'production'/)
  assert.match(source, /meta signature check skipped: secret missing/)
})
