import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import nodeFetch from 'node-fetch'

export const CRAWL_LIMITS = Object.freeze({ timeoutMs: 8_000, maxBytes: 2_000_000, maxRedirects: 3 })

export class CrawlError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'CrawlError'
    this.code = code
    this.status = status
  }
}

function blockedIp(address) {
  if (net.isIPv4(address)) {
    const n = address.split('.').map(Number)
    return n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] === 169 && n[1] === 254
      || n[0] === 172 && n[1] >= 16 && n[1] <= 31 || n[0] === 192 && n[1] === 168
      || n[0] === 100 && n[1] >= 64 && n[1] <= 127 || n[0] === 192 && n[1] === 0
      || n[0] === 198 && (n[1] === 18 || n[1] === 19) || n[0] >= 224
  }
  if (net.isIPv6(address)) {
    const ip = address.toLowerCase().split('%')[0]
    const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16)
      const low = Number.parseInt(mappedHex[2], 16)
      return blockedIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')
      || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')
      || ip.startsWith('ff') || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.')
      || ip.startsWith('::ffff:192.168.') || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(ip)
  }
  return true
}

async function resolveCrawlTarget(input, { lookup = dns.lookup } = {}) {
  let url
  try { url = new URL(input) } catch { throw new CrawlError('INVALID_URL', 'Ugyldig URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CrawlError('INVALID_URL', 'Kun HTTP(S)-URL uten credentials er tillatt')
  }
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) {
    throw new CrawlError('BLOCKED_PORT', 'Kun standard HTTP(S)-porter er tillatt')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new CrawlError('BLOCKED_TARGET', 'Lokale/private mål er blokkert')
  }
  const literal = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new CrawlError('DNS_FAILED', 'Kunne ikke slå opp vertsnavn', 502)
  })
  if (!literal.length || literal.some(({ address }) => blockedIp(address))) {
    throw new CrawlError('BLOCKED_TARGET', 'Lokale/private mål er blokkert')
  }
  url.hostname = host
  url.hash = ''
  return { url, addresses: Object.freeze(literal.map(({ address }) => address)) }
}

export function createPinnedLookup(hostname, approvedAddresses) {
  const expected = hostname.toLowerCase().replace(/\.$/, '')
  const approved = [...new Set(approvedAddresses)]
  if (!approved.length || approved.some(blockedIp)) throw new CrawlError('BLOCKED_TARGET', 'Ingen godkjente offentlige adresser')
  let cursor = 0
  return (requestedHost, options, callback) => {
    const requested = String(requestedHost).toLowerCase().replace(/\.$/, '')
    if (requested !== expected) return callback(new CrawlError('DNS_REBINDING', 'Transport forsøkte et annet vertsnavn', 502))
    const candidates = approved.map(address => ({ address, family: net.isIPv6(address) ? 6 : 4 }))
    if (options?.all) return callback(null, candidates)
    const selected = candidates[cursor++ % candidates.length]
    callback(null, selected.address, selected.family)
  }
}

// node-fetch accepts Node agents, allowing TLS SNI/Host to remain the validated
// hostname while socket resolution is pinned to the exact approved DNS set.
export function createPinnedFetch(fetchImpl = nodeFetch) {
  return (url, options = {}) => {
    const target = url instanceof URL ? url : new URL(url)
    const approved = options.yeeyooApprovedAddresses
    if (!Array.isArray(approved) || approved.length === 0) {
      throw new CrawlError('UNPINNED_TRANSPORT', 'Crawlertransport krever godkjente DNS-adresser', 500)
    }
    const lookup = createPinnedLookup(target.hostname, approved)
    const agent = target.protocol === 'https:'
      ? new https.Agent({ lookup, keepAlive: false, maxSockets: 1 })
      : new http.Agent({ lookup, keepAlive: false, maxSockets: 1 })
    const { yeeyooApprovedAddresses: _internal, ...requestOptions } = options
    return fetchImpl(target, { ...requestOptions, agent })
  }
}

export async function validateCrawlUrl(input, options = {}) {
  return (await resolveCrawlTarget(input, options)).url
}

function normalizeType(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase() }

export async function safeCrawl(input, options = {}) {
  const fetchImpl = options.fetchImpl || createPinnedFetch()
  const lookup = options.lookup || dns.lookup
  const timeoutMs = options.timeoutMs ?? CRAWL_LIMITS.timeoutMs
  const maxBytes = options.maxBytes ?? CRAWL_LIMITS.maxBytes
  const maxRedirects = options.maxRedirects ?? CRAWL_LIMITS.maxRedirects
  const allowedTypes = options.allowedTypes || ['text/html', 'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml']
  let validated = await resolveCrawlTarget(input, { lookup })
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const current = validated.url
    let response
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'YeeyooCrawler/1.0', Accept: allowedTypes.join(', ') }, yeeyooApprovedAddresses: validated.addresses })
    } catch (error) {
      throw new CrawlError(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED', error?.name === 'TimeoutError' ? 'Henting tok for lang tid' : 'Kunne ikke hente URL', 502)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) throw new CrawlError('TOO_MANY_REDIRECTS', 'For mange redirects', 502)
      const location = response.headers.get('location')
      if (!location) throw new CrawlError('INVALID_REDIRECT', 'Redirect mangler mål', 502)
      validated = await resolveCrawlTarget(new URL(location, current).href, { lookup })
      continue
    }
    if (!response.ok) throw new CrawlError('HTTP_ERROR', `Upstream svarte HTTP ${response.status}`, 502)
    const type = normalizeType(response.headers.get('content-type'))
    if (!allowedTypes.includes(type)) throw new CrawlError('UNSUPPORTED_CONTENT_TYPE', 'Ikke støttet innholdstype', 415)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new CrawlError('RESPONSE_TOO_LARGE', 'Responsen er for stor', 413)
    const chunks = []
    let size = 0
    if (!response.body) throw new CrawlError('EMPTY_RESPONSE', 'Responsen mangler innhold', 502)
    if (response.body.getReader) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) { await reader.cancel(); throw new CrawlError('RESPONSE_TOO_LARGE', 'Responsen er for stor', 413) }
        chunks.push(value)
      }
    } else {
      for await (const value of response.body) {
        size += value.byteLength
        if (size > maxBytes) { response.body.destroy?.(); throw new CrawlError('RESPONSE_TOO_LARGE', 'Responsen er for stor', 413) }
        chunks.push(value)
      }
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { url: current.href, contentType: type, body: new TextDecoder().decode(bytes), bytes: size, resolvedAddresses: validated.addresses }
  }
  throw new CrawlError('TOO_MANY_REDIRECTS', 'For mange redirects', 502)
}
