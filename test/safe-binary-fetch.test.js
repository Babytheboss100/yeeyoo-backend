import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { safeBinaryFetch } from '../src/services/safeBinaryFetch.js'

// SECURITY_AUDIT_2026-08-19.md HØY-1: fire hentesteder tok en URL fra klienten
// eller fra en provider og gikk utenom safeCrawler. safeCrawl() dekoder kroppen
// som tekst, så binærhenting trengte sin egen vei bak samme vakt.

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }]
const binary = (bytes, type = 'video/mp4') =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': type, 'content-length': String(bytes.length) } })

test('binærhenting avviser private, lokale og malformede mål', async () => {
  await assert.rejects(safeBinaryFetch('http://127.0.0.1/video.mp4'), { code: 'BLOCKED_TARGET' })
  await assert.rejects(safeBinaryFetch('http://169.254.169.254/latest/meta-data/'), { code: 'BLOCKED_TARGET' })
  await assert.rejects(safeBinaryFetch('http://intern.example', { lookup: async () => [{ address: '10.0.0.7', family: 4 }] }), { code: 'BLOCKED_TARGET' })
  await assert.rejects(safeBinaryFetch('file:///etc/passwd'), { code: 'INVALID_URL' })
  await assert.rejects(safeBinaryFetch('https://user:pass@example.com/v.mp4'), { code: 'INVALID_URL' })
  await assert.rejects(safeBinaryFetch('https://example.com:9001/v.mp4', { lookup: publicDns }), { code: 'BLOCKED_PORT' })
})

test('en redirect mot et internt mål blir revalidert og avvist', async () => {
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
  await assert.rejects(safeBinaryFetch('https://example.com/v.mp4', { lookup: publicDns, fetchImpl }), { code: 'BLOCKED_TARGET' })
})

test('bytes kommer tilbake urørt, ikke tekstdekodet', async () => {
  // Det som gjorde safeCrawl uegnet her: den kjører TextDecoder over kroppen.
  const bytes = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80]
  const result = await safeBinaryFetch('https://example.com/v.mp4', { lookup: publicDns, fetchImpl: async () => binary(bytes) })
  assert.ok(Buffer.isBuffer(result.buffer))
  assert.deepEqual([...result.buffer], bytes, 'bytene må overleve rundturen')
  assert.equal(result.bytes, bytes.length)
  assert.equal(result.contentType, 'video/mp4')
})

test('innholdstype og størrelse håndheves', async () => {
  await assert.rejects(
    safeBinaryFetch('https://example.com/x', { lookup: publicDns, allowedPrefixes: ['video/'], fetchImpl: async () => binary([1, 2], 'text/html') }),
    { code: 'UNSUPPORTED_CONTENT_TYPE' })
  await assert.rejects(
    safeBinaryFetch('https://example.com/x', { lookup: publicDns, maxBytes: 2, fetchImpl: async () => binary([1, 2, 3, 4]) }),
    { code: 'RESPONSE_TOO_LARGE' })
})

test('upstream-status lekker aldri tilbake til kalleren', async () => {
  // Den gamle youtube.js svarte `Kunne ikke hente videoUrl (${vidRes.status})`,
  // som gjorde interne porter tellbare. Koden må være generisk.
  await assert.rejects(
    safeBinaryFetch('https://example.com/x', { lookup: publicDns, fetchImpl: async () => new Response('', { status: 401 }) }),
    error => error.code === 'HTTP_ERROR' && !/401/.test(error.message))
})

test('transporten pinnes til det godkjente DNS-settet', async () => {
  let approved
  await safeBinaryFetch('https://example.com/v.mp4', {
    lookup: publicDns,
    fetchImpl: async (_url, options) => { approved = options.yeeyooApprovedAddresses; return binary([1]) },
  })
  assert.deepEqual(approved, ['93.184.216.34'])
})

test('de fire kallstedene går gjennom vakten og ikke rå fetch', () => {
  const read = name => fs.readFileSync(new URL(`../src/routes/${name}`, import.meta.url), 'utf8')

  const youtube = read('youtube.js')
  assert.match(youtube, /safeBinaryFetch\(videoUrl/)
  assert.doesNotMatch(youtube, /await fetch\(videoUrl\)/)
  assert.doesNotMatch(youtube, /Kunne ikke hente videoUrl \(\$\{vidRes\.status\}\)/)

  const images = read('images.js')
  assert.match(images, /safeBinaryFetch\(imageUrl/)
  assert.doesNotMatch(images, /await fetch\(imageUrl\)/)

  const autopilot = read('autopilot.js')
  assert.match(autopilot, /validateCrawlUrl\(url\)/)
  assert.match(autopilot, /encodeURI\(target\.href\)/)
  assert.doesNotMatch(autopilot, /r\.jina\.ai\/\$\{url\}/)

  const translate = read('translateImage.js')
  assert.match(translate, /await validateCrawlUrl\(imageUrl\)/)
  assert.match(translate, /if \(maskUrl\) await validateCrawlUrl\(maskUrl\)/)

  // safeCrawler.js er den godkjente vakten og skal være urørt av denne runden.
  const guard = fs.readFileSync(new URL('../src/services/safeCrawler.js', import.meta.url), 'utf8')
  assert.match(guard, /export async function safeCrawl/)
  assert.match(guard, /export function createPinnedLookup/)
})
