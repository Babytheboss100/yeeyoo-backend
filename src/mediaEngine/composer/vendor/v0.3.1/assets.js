// yeeyoo-media-composer — asset-resolusjon og lasting (v0.2)
// Offentlig kontrakt: assetId. Kalleren (Media Engine) leverer assetMap:
// { [assetId]: absoluttInternSti } etter tenant-verifisering og
// materialisering fra durable storage. Composer ser aldri klientstier.

import { loadImage, GlobalFonts } from '@napi-rs/canvas'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Registrer en font-fil (ttf/otf) under et familienavn. */
export function registerFont(path, family) {
  GlobalFonts.registerFromPath(path, family)
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
  if (project.audio?.music) refs.push({ kind: 'audio', ref: project.audio.music, key: 'audio:music' })
  if (project.audio?.voiceover) refs.push({ kind: 'audio', ref: project.audio.voiceover, key: 'audio:voiceover' })
  return refs
}

export const elKey = el => `el:${el.id}`
export const bgKey = scene => `bg:${scene.id}`

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
