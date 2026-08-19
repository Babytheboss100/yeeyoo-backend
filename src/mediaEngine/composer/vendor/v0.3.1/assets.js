// yeeyoo-media-composer — asset-resolusjon og lasting (v0.2)
// Offentlig kontrakt: assetId. Kalleren (Media Engine) leverer assetMap:
// { [assetId]: absoluttInternSti } etter tenant-verifisering og
// materialisering fra durable storage. Composer ser aldri klientstier.

import { loadImage, GlobalFonts } from '@napi-rs/canvas'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

const registeredFamilies = new Map()

/** Registrer en font-fil (ttf/otf) under et familienavn. */
export function registerFont(path, family, { expectedSha256 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error(`font checksum mangler: ${family}`)
  const size = statSync(path).size
  if (size < 1 || size > 20 * 1024 * 1024) throw new Error(`fontstørrelse er ugyldig: ${family}`)
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (sha256 !== expectedSha256) throw new Error(`font checksum mismatch: ${family}`)
  const runtimeFamily = `${family}__${sha256.slice(0, 16)}`
  const prior = registeredFamilies.get(runtimeFamily)
  if (!prior) {
    const ok = GlobalFonts.registerFromPath(path, runtimeFamily)
    if (ok === false) throw new Error(`fontregistrering feilet: ${family}`)
    registeredFamilies.set(runtimeFamily, sha256)
  }
  return Object.freeze({ family, runtimeFamily, sha256 })
}

/**
 * resolveRef(ref, assetMap) → absolutt sti eller null.
 * ref: { assetId } eller { src } (kun intern bruk, allerede validert).
 */
export function resolveRef(ref, assetMap) {
  if (ref.assetId != null) {
    const p = assetMap?.[ref.assetId]
    if (!p) throw new Error(`ukjent assetId: ${ref.assetId} (mangler i assetMap)`)
    return p
  }
  return ref.src ?? null
}

/** Samle alle refererte assets: [{kind: 'image'|'video'|'audio', ref, key}] */
export function collectAssetRefs(project) {
  const refs = []
  for (const scene of project.scenes) {
    if (scene.background && typeof scene.background === 'object')
      refs.push({ kind: 'image', ref: scene.background, key: bgKey(scene) })
    for (const el of scene.elements) {
      if (el.type === 'image') refs.push({ kind: 'image', ref: el, key: elKey(el) })
      if (el.type === 'video') refs.push({ kind: 'video', ref: el, key: elKey(el) })
    }
  }
  for (const font of project.fonts || []) refs.push({ kind: 'font', ref: font, key: fontKey(font) })
  if (project.audio?.music) refs.push({ kind: 'audio', ref: project.audio.music, key: 'audio:music' })
  if (project.audio?.voiceover) refs.push({ kind: 'audio', ref: project.audio.voiceover, key: 'audio:voiceover' })
  return refs
}

export const elKey = el => `el:${el.id}`
export const bgKey = scene => `bg:${scene.id}`
export const fontKey = font => `font:${font.family}`

/** Registrer prosjektfonter etter at resolver og checksum har godkjent dem. */
export function registerProjectFonts(project, resolved) {
  return Object.freeze((project.fonts || []).map(font => registerFont(
    resolved.get(fontKey(font)),
    font.family,
    { expectedSha256: font.sha256 },
  )))
}

/** Bind logisk familienavn til en checksum-isolert runtime-familie. */
export function applyRegisteredFonts(project, provenance) {
  const aliases = new Map((provenance || []).map(item => [item.family, item.runtimeFamily]))
  for (const scene of project.scenes || []) for (const element of scene.elements || []) {
    if (element.type === 'text' && aliases.has(element.style?.fontFamily)) element.style.fontFamily = aliases.get(element.style.fontFamily)
  }
  for (const caption of project.captions || []) if (aliases.has(caption.style?.fontFamily)) caption.style.fontFamily = aliases.get(caption.style.fontFamily)
  return project
}

/**
 * resolveAssets(project, assetMap) → Map<key, absPath>
 * Feiler høyt og tidlig: ukjent assetId, relativ sti eller manglende fil
 * stopper komponeringen FØR første frame.
 */
export function resolveAssets(project, assetMap) {
  const resolved = new Map()
  for (const { ref, key } of collectAssetRefs(project)) {
    const path = resolveRef(ref, assetMap)
    if (!path) throw new Error(`asset uten sti: ${key}`)
    if (!isAbsolute(path)) throw new Error(`asset må være absolutt intern sti: ${key}`)
    if (!existsSync(path)) throw new Error(`asset finnes ikke: ${key} → ${path}`)
    resolved.set(key, path)
  }
  return resolved
}

/** Last stillbilder (image + background) som Image-objekter. */
export async function loadImages(project, resolved) {
  const images = new Map()
  for (const { kind, key } of collectAssetRefs(project)) {
    if (kind !== 'image') continue
    images.set(key, await loadImage(resolved.get(key)))
  }
  return images
}
