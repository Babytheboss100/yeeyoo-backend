import dns from 'node:dns/promises'
import net from 'node:net'

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

export async function validateCrawlUrl(input, options = {}) {
  return (await resolveCrawlTarget(input, options)).url
}

function normalizeType(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase() }

export async function safeCrawl(input, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
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
    const reader = response.body?.getReader()
    if (!reader) throw new CrawlError('EMPTY_RESPONSE', 'Responsen mangler innhold', 502)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new CrawlError('RESPONSE_TOO_LARGE', 'Responsen er for stor', 413) }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { url: current.href, contentType: type, body: new TextDecoder().decode(bytes), bytes: size, resolvedAddresses: validated.addresses }
  }
  throw new CrawlError('TOO_MANY_REDIRECTS', 'For mange redirects', 502)
}
