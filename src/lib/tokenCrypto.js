// Token-kryptering (HOLO Sesjon J — sikkerhet).
//
// AES-256-GCM. Nøkkel fra env META_TOKEN_ENCRYPTION_KEY (64 hex-tegn = 32 bytes,
// ellers SHA-256-derivert fra vilkårlig streng). Lagret format:
//   enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
//
// Bakoverkompatibel: decryptToken() returnerer klartekst uendret (rader satt
// manuelt før migrering). Kjør scripts/encrypt-tokens.js for å kryptere dem.

import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const PREFIX = 'enc:v1:'

function getKey() {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!raw) return null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  // Vilkårlig passphrase → deriver 32 bytes deterministisk.
  return crypto.createHash('sha256').update(raw).digest()
}

export function isEncrypted(val) {
  return typeof val === 'string' && val.startsWith(PREFIX)
}

export function encryptToken(plain) {
  if (plain == null) return plain
  if (isEncrypted(plain)) return plain
  const key = getKey()
  if (!key) return plain // ikke konfigurert (dev) → lagre som er
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptToken(stored) {
  if (stored == null) return stored
  if (!isEncrypted(stored)) return stored // klartekst (pre-migrering)
  const key = getKey()
  if (!key) throw new Error('META_TOKEN_ENCRYPTION_KEY mangler — kan ikke dekryptere token')
  const [, , ivB64, tagB64, ctB64] = stored.split(':')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
