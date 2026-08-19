// Binærsikker henting bak den godkjente SSRF-vakten.
//
// safeCrawl() dekoder kroppen som tekst og er bygget for HTML/XML. Video- og
// bildehenting trenger rå bytes, så denne komponerer det eksporterte API-et fra
// safeCrawler.js i stedet for å omgå det. safeCrawler.js selv er urørt.
//
// Beskyttelsen kommer fra to lag, begge inne i den godkjente vakten:
//   1. validateCrawlUrl()  - skjema, port, credentials, vertsnavn, og DNS-oppslag
//                            der hver adresse må være offentlig.
//   2. createPinnedFetch() - pinner socket-oppslaget til de godkjente adressene og
//                            avviser DNS-rebinding. createPinnedLookup() kjører
//                            blockedIp() på nytt over adressene vi sender inn, så
//                            adressefiltreringen eies fortsatt av vakten.
//
// Hver redirect valideres på nytt gjennom samme løype.

import dns from 'node:dns/promises'
import { CrawlError, createPinnedFetch, validateCrawlUrl } from './safeCrawler.js'

export const BINARY_LIMITS = Object.freeze({ timeoutMs: 20_000, maxBytes: 64 * 1024 * 1024, maxRedirects: 3 })

const pinnedFetch = createPinnedFetch()

async function approvedAddressesFor(url, lookup) {
  const resolved = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => {
    throw new CrawlError('DNS_FAILED', 'Kunne ikke slå opp vertsnavn', 502)
  })
  return resolved.map(({ address }) => address)
}

/**
 * Hent rå bytes fra en ekstern URL uten å kunne nå private eller lokale mål.
 *
 * @returns {Promise<{ url: string, contentType: string, buffer: Buffer, bytes: number }>}
 * @throws {CrawlError} ved blokkert mål, for stor respons, feil innholdstype eller timeout.
 */
export async function safeBinaryFetch(input, options = {}) {
  const timeoutMs = options.timeoutMs ?? BINARY_LIMITS.timeoutMs
  const maxBytes = options.maxBytes ?? BINARY_LIMITS.maxBytes
  const maxRedirects = options.maxRedirects ?? BINARY_LIMITS.maxRedirects
  const allowedPrefixes = options.allowedPrefixes || null
  const lookup = options.lookup || dns.lookup
  const fetchImpl = options.fetchImpl || pinnedFetch

  let current = await validateCrawlUrl(input, { lookup })

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const addresses = await approvedAddressesFor(current, lookup)
    let response
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'YeeyooCrawler/1.0' },
        yeeyooApprovedAddresses: addresses,
      })
    } catch (error) {
      if (error instanceof CrawlError) throw error
      throw new CrawlError(
        error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED',
        error?.name === 'TimeoutError' ? 'Henting tok for lang tid' : 'Kunne ikke hente URL',
        502,
      )
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) throw new CrawlError('TOO_MANY_REDIRECTS', 'For mange redirects', 502)
      const location = response.headers.get('location')
      if (!location) throw new CrawlError('INVALID_REDIRECT', 'Redirect mangler mål', 502)
      current = await validateCrawlUrl(new URL(location, current).href, { lookup })
      continue
    }

    // Upstream-status blir aldri videreformidlet til kalleren: den ville gjort
    // dette til et orakel for interne porter.
    if (!response.ok) throw new CrawlError('HTTP_ERROR', 'Kunne ikke hente URL', 502)

    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    if (allowedPrefixes && !allowedPrefixes.some(prefix => contentType.startsWith(prefix))) {
      throw new CrawlError('UNSUPPORTED_CONTENT_TYPE', 'Ikke støttet innholdstype', 415)
    }
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
        chunks.push(Buffer.from(value))
      }
    } else {
      for await (const value of response.body) {
        size += value.byteLength
        if (size > maxBytes) { response.body.destroy?.(); throw new CrawlError('RESPONSE_TOO_LARGE', 'Responsen er for stor', 413) }
        chunks.push(Buffer.from(value))
      }
    }
    return { url: current.href, contentType, buffer: Buffer.concat(chunks), bytes: size }
  }
  throw new CrawlError('TOO_MANY_REDIRECTS', 'For mange redirects', 502)
}
