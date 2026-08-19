// yeeyoo-media-composer — FFmpeg-encoding (v0.2)
// FFmpeg som separat prosess (aldri linket). P0.5: -shortest er FJERNET —
// videoens tidslinje bestemmer varigheten. Lyd paddes med apad og kuttes
// med -t <duration>, så output-varighet === prosjekt-varighet alltid.
//
// Lisensmerknad (P0.8): libx264-builds av FFmpeg er typisk GPL. Kjørt som
// separat prosess på egen server (ingen distribusjon av binæren til kunder)
// utløser ikke GPL-forpliktelser for vår kode. Distribueres binæren noen
// gang MED produktet, må build og notices vurderes på nytt. Dokumentér
// hvilken FFmpeg-build som kjører i prod (ffmpeg -version i runbook).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * buildFfmpegArgs({width,height,fps,outPath,duration,audio}) → string[]
 * audio: {
 *   music: {path, volume, fadeOut}, voiceover: {path, volume},
 *   clips: [{path, volume, srcStart, srcEnd, delaySeconds}],
 *   ducking: {enabled, threshold, ratio, attackMs, releaseMs}
 * }
 * (interne stier — allerede resolvert fra assetId av compose.js)
 */
export function buildFfmpegArgs({ width, height, fps, outPath, duration, audio }) {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
  ]

  const music = audio?.music ?? null
  const vo = audio?.voiceover ?? null
  const clips = Array.isArray(audio?.clips) ? audio.clips : []
  if (music) args.push('-i', music.path)
  if (vo) args.push('-i', vo.path)
  for (const clip of clips) args.push('-i', clip.path)

  if (music || vo || clips.length) {
    const parts = []
    const bedInputs = []
    let idx = 1
    if (music) {
      const fade = music.fadeOut !== false && duration > 1.5
        ? `,afade=t=out:st=${(duration - 1.2).toFixed(2)}:d=1.2`
        : ''
      parts.push(`[${idx}:a]volume=${music.volume}${fade},apad[m]`)
      bedInputs.push('[m]')
      idx++
    }
    if (vo) {
      parts.push(`[${idx}:a]volume=${vo.volume},apad[v]`)
      idx++
    }
    clips.forEach((clip, clipIndex) => {
      const trimEnd = Number.isFinite(clip.srcEnd) ? `:end=${clip.srcEnd}` : ''
      const delayMs = Math.max(0, Math.round((clip.delaySeconds || 0) * 1000))
      parts.push(`[${idx}:a]atrim=start=${clip.srcStart || 0}${trimEnd},asetpts=PTS-STARTPTS,volume=${clip.volume},adelay=${delayMs}:all=1,apad[c${clipIndex}]`)
      bedInputs.push(`[c${clipIndex}]`)
      idx++
    })

    let bed = null
    if (bedInputs.length === 1) {
      parts.push(`${bedInputs[0]}anull[bed]`)
      bed = '[bed]'
    } else if (bedInputs.length > 1) {
      parts.push(`${bedInputs.join('')}amix=inputs=${bedInputs.length}:duration=longest:dropout_transition=0[bed]`)
      bed = '[bed]'
    }

    if (vo && bed && audio?.ducking?.enabled === true) {
      const d = audio.ducking
      parts.push(`[v]asplit=2[vside][vmix]`)
      parts.push(`${bed}[vside]sidechaincompress=threshold=${d.threshold}:ratio=${d.ratio}:attack=${d.attackMs}:release=${d.releaseMs}[ducked]`)
      parts.push(`[ducked][vmix]amix=inputs=2:duration=longest:dropout_transition=0[a]`)
    } else if (vo && bed) {
      parts.push(`${bed}[v]amix=inputs=2:duration=longest:dropout_transition=0[a]`)
    } else if (vo) {
      parts.push('[v]anull[a]')
    } else {
      parts.push(`${bed}anull[a]`)
    }
    args.push('-filter_complex', parts.join(';'))
    args.push('-map', '0:v', '-map', '[a]')
  }

  args.push(
    '-t', duration.toFixed(3), // P0.5: eksakt mållengde — tidslinjen bestemmer
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '20',
    '-movflags', '+faststart',
  )
  if (music || vo || clips.length) args.push('-c:a', 'aac', '-b:a', '160k')
  args.push(outPath)
  return args
}

/**
 * createEncoder(opts) → { writeFrame(buf), finish(), kill() }
 * opts.outPath skal være en TEMPORÆR sti — compose.js eier atomisk rename.
 */
export function createEncoder(opts) {
  const { ffmpegPath = 'ffmpeg', signal, spawnImpl = spawn } = opts
  if (signal?.aborted) {
    const error = new Error('kansellert')
    error.code = 'CANCELLED'
    throw error
  }
  if (opts.audio?.music && !existsSync(opts.audio.music.path))
    throw new Error(`musikkfil finnes ikke: ${opts.audio.music.path}`)
  if (opts.audio?.voiceover && !existsSync(opts.audio.voiceover.path))
    throw new Error(`voiceover-fil finnes ikke: ${opts.audio.voiceover.path}`)
  for (const clip of opts.audio?.clips || []) {
    if (!existsSync(clip.path)) throw new Error(`klipplydfil finnes ikke: ${clip.path}`)
  }

  const args = buildFfmpegArgs(opts)
  const proc = spawnImpl(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderrTail = ''
  let forcedError = null
  proc.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-4000) })

  const abort = () => {
    if (forcedError) return
    forcedError = new Error('kansellert')
    forcedError.code = 'CANCELLED'
    try { proc.stdin.destroy() } catch {}
    try { proc.kill('SIGKILL') } catch {}
  }
  signal?.addEventListener('abort', abort, { once: true })

  const done = new Promise((resolve, reject) => {
    proc.on('error', error => {
      signal?.removeEventListener('abort', abort)
      reject(forcedError || error)
    })
    proc.on('close', code => {
      signal?.removeEventListener('abort', abort)
      if (forcedError) reject(forcedError)
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg avsluttet med kode ${code}: ${stderrTail.slice(-800)}`))
    })
  })
  // Unngå unhandled rejection hvis kill() brukes før finish() awaites.
  done.catch(() => {})

  return {
    writeFrame(buf) {
      return new Promise((resolve, reject) => {
        if (!proc.stdin.writable) return reject(new Error('ffmpeg stdin er lukket'))
        proc.stdin.write(buf, err => (err ? reject(err) : undefined))
        if (proc.stdin.writableNeedDrain) proc.stdin.once('drain', resolve)
        else resolve()
      })
    },
    async finish() {
      proc.stdin.end()
      await done
    },
    async kill() {
      if (!forcedError) {
        forcedError = new Error('ffmpeg ble terminert')
        forcedError.code = 'CANCELLED'
      }
      try { proc.stdin.destroy() } catch {}
      try { proc.kill('SIGKILL') } catch {}
      await done.catch(() => {})
    },
  }
}
