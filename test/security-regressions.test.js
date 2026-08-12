import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizePublicWebsiteUrl } from '../src/marketing/websiteUrl.js'

test('marketing audit accepts public URLs and rejects local/private targets', () => {
  assert.equal(normalizePublicWebsiteUrl(' HTTPS://Example.COM/path#fragment '), 'https://example.com/path')
  for (const value of ['http://localhost', 'http://127.0.0.1', 'http://10.0.0.1', 'http://192.168.1.1', 'ftp://example.com']) {
    assert.throws(() => normalizePublicWebsiteUrl(value))
  }
})

test('inbox and WhatsApp contain no first-admin ownership fallback', () => {
  const inbox = fs.readFileSync(new URL('../src/routes/inbox.js', import.meta.url), 'utf8')
  const whatsapp = fs.readFileSync(new URL('../src/routes/whatsapp.js', import.meta.url), 'utf8')
  assert.doesNotMatch(inbox, /is_admin\s*=\s*TRUE/)
  assert.doesNotMatch(whatsapp, /is_admin\s*=\s*TRUE/)
})

test('billing debug is authenticated, admin-only and does not call Stripe', () => {
  const billing = fs.readFileSync(new URL('../src/routes/billing.js', import.meta.url), 'utf8')
  assert.match(billing, /r\.get\('\/debug', auth/)
  assert.match(billing, /req\.user\.is_admin/)
  assert.doesNotMatch(billing, /stripe\.products\.list/)
  assert.doesNotMatch(billing, /stripe_key_prefix/)
})
