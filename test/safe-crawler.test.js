import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinnedFetch, createPinnedLookup, safeCrawl, validateCrawlUrl } from '../src/services/safeCrawler.js'
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }]
test('crawler rejects malformed and private targets', async () => { await assert.rejects(validateCrawlUrl('not a url'), { code: 'INVALID_URL' }); await assert.rejects(validateCrawlUrl('http://127.0.0.1/x'), { code: 'BLOCKED_TARGET' }); await assert.rejects(validateCrawlUrl('http://internal.example', { lookup: async () => [{ address: '10.0.0.1', family: 4 }] }), { code: 'BLOCKED_TARGET' }) })
test('crawler rejects credentials, alternate ports, carrier NAT and benchmark ranges', async () => {
  await assert.rejects(validateCrawlUrl('https://user:pass@example.com'), { code: 'INVALID_URL' })
  await assert.rejects(validateCrawlUrl('https://example.com:8443', { lookup: publicDns }), { code: 'BLOCKED_PORT' })
  await assert.rejects(validateCrawlUrl('https://carrier.example', { lookup: async () => [{ address: '100.64.0.1', family: 4 }] }), { code: 'BLOCKED_TARGET' })
  await assert.rejects(validateCrawlUrl('https://benchmark.example', { lookup: async () => [{ address: '198.18.0.1', family: 4 }] }), { code: 'BLOCKED_TARGET' })
  await assert.rejects(validateCrawlUrl('http://[::ffff:7f00:1]'), { code: 'BLOCKED_TARGET' })
})
test('crawler revalidates redirect destinations', async () => { const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } }); await assert.rejects(safeCrawl('https://example.com', { lookup: publicDns, fetchImpl }), { code: 'BLOCKED_TARGET' }) })
test('crawler enforces content type and response size', async () => { await assert.rejects(safeCrawl('https://example.com', { lookup: publicDns, fetchImpl: async () => new Response('x', { headers: { 'content-type': 'image/png' } }) }), { code: 'UNSUPPORTED_CONTENT_TYPE' }); await assert.rejects(safeCrawl('https://example.com', { lookup: publicDns, maxBytes: 2, fetchImpl: async () => new Response('abc', { headers: { 'content-type': 'text/html' } }) }), { code: 'RESPONSE_TOO_LARGE' }) })
test('crawler returns bounded supported content', async () => { const result = await safeCrawl('https://example.com/#secret', { lookup: publicDns, fetchImpl: async () => new Response('<h1>ok</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) }); assert.equal(result.body, '<h1>ok</h1>'); assert.equal(result.url, 'https://example.com/') })
test('crawler passes the approved DNS set to a connection-aware fetch adapter', async () => {
  let approved
  await safeCrawl('https://example.com', { lookup: publicDns, fetchImpl: async (_url, options) => { approved = options.yeeyooApprovedAddresses; return new Response('ok', { headers: { 'content-type': 'text/html' } }) } })
  assert.deepEqual(approved, ['93.184.216.34'])
})
test('pinned lookup never performs a second DNS lookup and rejects another hostname', () => {
  const lookup = createPinnedLookup('example.com', ['93.184.216.34'])
  lookup('example.com', {}, (error, address, family) => { assert.ifError(error); assert.equal(address, '93.184.216.34'); assert.equal(family, 4) })
  lookup('attacker.example', {}, error => assert.equal(error.code, 'DNS_REBINDING'))
})
test('pinned transport supplies an agent whose lookup returns only the validated address', async () => {
  let transportOptions
  const fetch = createPinnedFetch(async (_url, options) => { transportOptions = options; return new Response('ok') })
  await fetch(new URL('https://example.com/path'), { yeeyooApprovedAddresses: ['93.184.216.34'] })
  assert.ok(transportOptions.agent)
  transportOptions.agent.options.lookup('example.com', { all: true }, (error, addresses) => { assert.ifError(error); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]) })
  assert.throws(() => fetch(new URL('https://example.com'), {}), { code: 'UNPINNED_TRANSPORT' })
})
test('crawler blocks redirect DNS rebinding before a second connection', async () => {
  let calls = 0
  const lookup = async host => host === 'example.com' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
  const fetchImpl = async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://rebind.example/secret' } }) }
  await assert.rejects(safeCrawl('https://example.com', { lookup, fetchImpl }), { code: 'BLOCKED_TARGET' })
  assert.equal(calls, 1)
})
test('crawler rejects IPv4-mapped private IPv6 dotted notation and DNS mixed answers', async () => {
  await assert.rejects(validateCrawlUrl('http://[::ffff:127.0.0.1]'), { code: 'BLOCKED_TARGET' })
  await assert.rejects(validateCrawlUrl('https://mixed.example', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }), { code: 'BLOCKED_TARGET' })
})
