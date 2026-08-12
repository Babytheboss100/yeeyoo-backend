import { isIP } from 'node:net'

const blockedNames = new Set(['localhost', 'localhost.localdomain'])
const privateIpv4 = (host) => {
  const [a, b] = host.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function normalizePublicWebsiteUrl(value) {
  const url = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Ugyldig websiteUrl')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (blockedNames.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new TypeError('Privat websiteUrl er ikke tillatt')
  if (isIP(host) === 4 && privateIpv4(host)) throw new TypeError('Privat websiteUrl er ikke tillatt')
  if (isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'))) throw new TypeError('Privat websiteUrl er ikke tillatt')
  url.hostname = host
  url.hash = ''
  return url.toString()
}
