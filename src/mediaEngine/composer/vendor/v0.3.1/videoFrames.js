// yeeyoo-media-composer — videoklipp-elementer (v0.2, P0.1)
// Strategi: pre-ekstraher klippets frames med FFmpeg til JPEG-sekvens i
// jobbens temp-mappe ved prosjektets fps, skalert til draw-størrelse.
// Compose-løkken laster KUN gjeldende frame per iterasjon (minne-lett).
// Klippets lydspor mikses IKKE i v0.2 (dokumentert begrensning).

import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const VIDEO_EXTRACTION_LIMITS = Object.freeze({
  maxSourceDurationSec: 10 * 60,
  maxSourceDimension: 8192,
  maxSourceBytes: 1024 * 1024 * 1024,
  maxFrames: 3600,
  maxTempBytes: 2 * 1024 * 1024 * 1024,
})

function processError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function runProcess(cmd, args, { signal, spawnImpl = spawn, onTick, tickMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(processError('CANCELLED', 'kansellert'))
    const proc = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', errTail = ''
    let forcedError = null
    let settled = false
    let timer = null
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-2000) })
    const killWith = error => {
      if (forcedError) return
      forcedError = error
      try { proc.kill('SIGKILL') } catch {}
    }
    const abort = () => killWith(processError('CANCELLED', 'kansellert'))
    signal?.addEventListener('abort', abort, { once: true })
    if (onTick) timer = setInterval(() => {
      try { onTick() } catch (error) { killWith(error) }
    }, tickMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(value)
    }
    proc.on('error', error => finish(error))
    proc.on('close', code => {
      if (forcedError) return finish(forcedError)
      return code === 0 ? finish(null, out) : finish(new Error(`${cmd} kode ${code}: ${errTail.slice(-500)}`))
    })
  })
}

/** ffprobe på en mediefil → { durationSec, width, height, codec, hasAudio } */
export async function probeMedia(path, { ffprobePath = 'ffprobe', signal, spawnImpl } = {}) {
  const out = await runProcess(ffprobePath, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', path,
  ], { signal, spawnImpl })
  const j = JSON.parse(out)
  const v = (j.streams || []).find(s => s.codec_type === 'video')
  const a = (j.streams || []).find(s => s.codec_type === 'audio')
  return {
    durationSec: parseFloat(j.format?.duration ?? 'NaN'),
    width: v?.width ?? null,
    height: v?.height ?? null,
    codec: v?.codec_name ?? null,
    frameRate: v?.r_frame_rate ?? null,
    hasAudio: !!a,
    sizeBytes: parseInt(j.format?.size ?? '0', 10),
  }
}

/**
 * extractClipFrames({ inputPath, outDir, fps, srcStart, windowSec, maxW, maxH,
 *   loop, ffmpegPath }) → { dir, count }
 * Ekstraherer nøyaktig de frames elementvinduet trenger. Hvis klippet er
 * kortere enn vinduet: loop=false → siste frame fryses ved oppslag (clamp),
 * loop=true → sekvens gjentas ved oppslag (modulo). Selve ekstraksjonen tar
 * bare det som finnes i kilden.
 */
export async function extractClipFrames({
  inputPath, outDir, fps, srcStart = 0, srcEnd = null, windowSec,
  maxW, maxH, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe',
  signal, spawnImpl, maxFrames = VIDEO_EXTRACTION_LIMITS.maxFrames,
  maxTempBytes = VIDEO_EXTRACTION_LIMITS.maxTempBytes,
}) {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || !Number.isSafeInteger(maxTempBytes) || maxTempBytes < 1) throw processError('RESOURCE_LIMIT', 'ugyldige extraction-grenser')
  const probe = await probeMedia(inputPath, { ffprobePath, signal, spawnImpl })
  if (!probe.codec) throw new Error(`ikke en videofil: ${inputPath}`)
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0 || probe.durationSec > VIDEO_EXTRACTION_LIMITS.maxSourceDurationSec) throw processError('RESOURCE_LIMIT', 'videokildens varighet overskrider grensen')
  if (!Number.isSafeInteger(probe.width) || !Number.isSafeInteger(probe.height) || probe.width < 1 || probe.height < 1 || probe.width > VIDEO_EXTRACTION_LIMITS.maxSourceDimension || probe.height > VIDEO_EXTRACTION_LIMITS.maxSourceDimension) throw processError('RESOURCE_LIMIT', 'videokildens dimensjoner overskrider grensen')
  if (!Number.isSafeInteger(probe.sizeBytes) || probe.sizeBytes < 1 || probe.sizeBytes > VIDEO_EXTRACTION_LIMITS.maxSourceBytes) throw processError('RESOURCE_LIMIT', 'videokildens størrelse overskrider grensen')
  const available = Math.max(0, (Number.isFinite(probe.durationSec) ? probe.durationSec : 0) - srcStart)
  if (available <= 0) throw new Error(`srcStart (${srcStart}s) er forbi klippets slutt`)
  const trimmed = srcEnd != null ? Math.min(available, srcEnd - srcStart) : available
  const take = Math.min(trimmed, windowSec)
  const expectedFrames = Math.ceil(take * fps)
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || expectedFrames > maxFrames) throw processError('RESOURCE_LIMIT', 'videoklippet overskrider framegrensen')
  if (![fps, maxW, maxH].every(Number.isSafeInteger) || fps < 1 || maxW < 1 || maxH < 1 || maxW > 2160 || maxH > 2160) throw processError('RESOURCE_LIMIT', 'videoklippets rendergrenser er ugyldige')

  mkdirSync(outDir, { recursive: true })
  const tempBytes = () => readdirSync(outDir).reduce((sum, name) => {
    const info = statSync(join(outDir, name))
    return sum + (info.isFile() ? info.size : 0)
  }, 0)
  // Skaler ned til draw-boks (aldri opp) — bounder minne og disk.
  const vf = `fps=${fps},scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease`
  await runProcess(ffmpegPath, [
    '-y', '-ss', String(srcStart), '-t', take.toFixed(3),
    '-i', inputPath,
    '-vf', vf, '-frames:v', String(expectedFrames), '-q:v', '3',
    join(outDir, 'f_%05d.jpg'),
  ], {
    signal,
    spawnImpl,
    onTick: () => { if (tempBytes() > maxTempBytes) throw processError('RESOURCE_LIMIT', 'videoklippet overskrider tempgrensen') },
  })
  const count = readdirSync(outDir).filter(f => f.startsWith('f_')).length
  if (count === 0) throw new Error(`0 frames ekstrahert fra ${inputPath}`)
  const usedTempBytes = tempBytes()
  if (count > maxFrames || usedTempBytes > maxTempBytes) throw processError('RESOURCE_LIMIT', 'videoklippet overskrider extraction-grensen')
  return { dir: outDir, count, probe, tempBytes: usedTempBytes }
}

/**
 * clipFramePath(extract, frameIndex, loop) → sti til riktig frame.
 * clamp (freeze) eller modulo (loop) når vinduet er lengre enn klippet.
 */
export function clipFramePath(extract, frameIndex, loop) {
  let n
  if (loop) n = (frameIndex % extract.count) + 1
  else n = Math.min(frameIndex + 1, extract.count)
  const p = join(extract.dir, `f_${String(n).padStart(5, '0')}.jpg`)
  return existsSync(p) ? p : join(extract.dir, `f_${String(extract.count).padStart(5, '0')}.jpg`)
}
