// yeeyoo-media-composer — orkestrering (v0.2)
// P0.2: assetId → intern sti via assetMap (kalleren har tenant-verifisert).
// P0.3: atomisk output — temp-fil, verifiser, rename; cleanup i finally.
// P0.4: ffprobe + sha256 før suksess erklæres.
// P0.1: videoklipp via pre-ekstraherte frames, lastet én per iterasjon.

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdtempSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { validateProject } from './schema.js'
import { computeTimeline } from './timeline.js'
import { renderFrame } from './renderFrame.js'
import { resolveAssets, loadImages, registerProjectFonts, applyRegisteredFonts, elKey } from './assets.js'
import { createEncoder } from './encode.js'
import { extractClipFrames, clipFramePath } from './videoFrames.js'
import { verifyOutput } from './verify.js'

/**
 * composeVideo(projectInput, {
 *   outPath,           // absolutt sti til endelig .mp4 (skrives atomisk)
 *   assetMap,          // { [assetId]: absolutt intern sti } — tenant-resolvert av kalleren
 *   allowLocalPaths,   // KUN intern/test-bruk: tillat src-stier i prosjektet
 *   onProgress,        // ({frame, totalFrames, percent}) => void
 *   signal,            // AbortSignal
 *   ffmpegPath, ffprobePath,
 * }) → { outPath, sha256, sizeBytes, probe, totalFrames, durationSeconds, width, height, fps }
 */
export async function composeVideo(projectInput, opts) {
  const {
    outPath, assetMap = {}, allowLocalPaths = false,
    onProgress, signal, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe',
  } = opts
  if (!outPath) throw new Error('outPath kreves')

  const { ok, errors, project } = validateProject(projectInput, { allowLocalPaths })
  if (!ok) {
    const msg = errors.slice(0, 8).map(e => `${e.code}@${e.path}`).join('; ')
    throw new Error(`ugyldig prosjekt: ${msg}${errors.length > 8 ? ` (+${errors.length - 8})` : ''}`)
  }

  const timeline = computeTimeline(project)
  const { width, height, fps } = project.canvas

  // Jobbmappe for temp-output og ekstraherte klipp-frames.
  const workDir = mkdtempSync(join(tmpdir(), 'yeeyoo-compose-'))
  const tmpOut = join(workDir, 'out.mp4')
  let encoder = null
  let extractedFrames = 0
  let extractedTempBytes = 0
  const maxExtractedFrames = 3600
  const maxExtractionTempBytes = 2 * 1024 * 1024 * 1024

  try {
    // Resolver alle assets FØR noe annet — fail fast.
    const resolved = resolveAssets(project, assetMap)
    const images = await loadImages(project, resolved)
    const fontProvenance = registerProjectFonts(project, resolved)
    applyRegisteredFonts(project, fontProvenance)

    // Pre-ekstraher frames for hvert video-element.
    const clips = new Map() // el.id → { extract, el, sceneIndex }
    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i]
      for (const el of scene.elements) {
        if (el.type !== 'video') continue
        if (signal?.aborted) throw new Error('kansellert')
        const inputPath = resolved.get(elKey(el))
        // Defense-in-depth: aldri klientdata i filsti — indeksbasert mappenavn
        // (schema håndhever i tillegg [A-Za-z0-9_-] på IDer).
        const extract = await extractClipFrames({
          inputPath,
          outDir: join(workDir, `clip-${i}-${scene.elements.indexOf(el)}`),
          fps,
          srcStart: el.srcStart,
          srcEnd: el.srcEnd ?? null,
          windowSec: scene.duration,
          maxW: Math.ceil((el.w ?? 1) * width),
          maxH: Math.ceil((el.h ?? 1) * height),
          ffmpegPath, ffprobePath,
          signal,
          maxFrames: maxExtractedFrames - extractedFrames,
          maxTempBytes: maxExtractionTempBytes - extractedTempBytes,
        })
        extractedFrames += extract.count
        extractedTempBytes += extract.tempBytes
        clips.set(el.id, { extract, el, sceneIndex: i })
      }
    }

    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')

    const clipAudio = []
    for (const { el, sceneIndex } of clips.values()) {
      if (el.audio !== true && el.audio?.enabled !== true) continue
      const sceneTiming = timeline.scenes[sceneIndex]
      const srcEnd = el.srcEnd ?? (el.srcStart + project.scenes[sceneIndex].duration)
      clipAudio.push({
        path: resolved.get(elKey(el)),
        volume: el.audio === true ? 1 : el.audio.volume,
        srcStart: el.srcStart,
        srcEnd,
        delaySeconds: sceneTiming.start,
      })
    }
    const expectAudio = !!(project.audio?.music || project.audio?.voiceover || clipAudio.length)
    encoder = createEncoder({
      width, height, fps, outPath: tmpOut, ffmpegPath,
      signal,
      duration: timeline.totalDuration,
      audio: expectAudio ? {
        music: project.audio?.music
          ? { path: resolved.get('audio:music'), volume: project.audio.music.volume, fadeOut: project.audio.music.fadeOut }
          : null,
        voiceover: project.audio?.voiceover
          ? { path: resolved.get('audio:voiceover'), volume: project.audio.voiceover.volume }
          : null,
        clips: clipAudio,
        ducking: project.audio?.ducking ?? null,
      } : null,
    })

    // Liten cache så samme klipp-frame ikke dekodes to ganger (overlapp).
    const frameCache = new Map()
    for (let f = 0; f < timeline.totalFrames; f++) {
      if (signal?.aborted) throw new Error('kansellert')
      const t = f / fps

      // Last gjeldende frame for aktive video-elementer (minne-lett: én om gangen).
      for (const [elId, { extract, el, sceneIndex }] of clips) {
        const sc = timeline.scenes[sceneIndex]
        if (t < sc.start || t >= sc.end) { images.delete(`videoframe:${elId}`); continue }
        const localT = t - sc.start
        const idx = Math.floor(localT * fps)
        const p = clipFramePath(extract, idx, el.loop)
        let img = frameCache.get(p)
        if (!img) {
          img = await loadImage(p)
          frameCache.clear() // hold cachen på ~antall aktive klipp
          frameCache.set(p, img)
        }
        images.set(`videoframe:${elId}`, img)
      }

      renderFrame(ctx, project, timeline, t, images)
      const { data } = ctx.getImageData(0, 0, width, height)
      await encoder.writeFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      if (onProgress && (f % fps === 0 || f === timeline.totalFrames - 1)) {
        onProgress({
          frame: f + 1,
          totalFrames: timeline.totalFrames,
          percent: Math.round(((f + 1) / timeline.totalFrames) * 100),
        })
      }
    }
    await encoder.finish()
    encoder = null

    // P0.4: bevis at filen er gyldig FØR den får endelig navn.
    const verification = await verifyOutput(tmpOut, {
      width, height, fps,
      duration: timeline.totalDuration,
      expectAudio,
      ffprobePath,
      signal,
    })

    // P0.3: atomisk — rename til endelig sti (samme volum kreves av kalleren;
    // kryss-volum faller tilbake til copy+rename via workDir-plassering).
    if (!existsSync(dirname(outPath))) throw new Error(`målmappe finnes ikke: ${dirname(outPath)}`)
    try {
      renameSync(tmpOut, outPath)
    } catch (e) {
      if (e.code === 'EXDEV') {
        const { copyFileSync } = await import('node:fs')
        const stage = outPath + '.tmp-' + process.pid
        copyFileSync(tmpOut, stage)
        renameSync(stage, outPath)
      } else throw e
    }

    return {
      outPath,
      sha256: verification.sha256,
      sizeBytes: verification.sizeBytes,
      probe: verification.probe,
      totalFrames: timeline.totalFrames,
      durationSeconds: timeline.totalDuration,
      width, height, fps,
      fonts: fontProvenance,
    }
  } catch (e) {
    if (encoder) await encoder.kill()
    throw e
  } finally {
    // Cleanup: temp-fil, klipp-frames, jobbmappe. Aldri etterlat delvis output.
    try { rmSync(workDir, { recursive: true, force: true }) } catch {}
  }
}
