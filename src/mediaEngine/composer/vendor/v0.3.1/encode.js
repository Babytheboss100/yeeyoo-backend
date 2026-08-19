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
 * audio: { music: {path, volume, fadeOut}, voiceover: {path, volume} }
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
  if (music) args.push('-i', music.path)
  if (vo) args.push('-i', vo.path)

  if (music || vo) {
    const parts = []
    const mixIn = []
    let idx = 1
    if (music) {
      const fade = music.fadeOut !== false && duration > 1.5
        ? `,afade=t=out:st=${(duration - 1.2).toFixed(2)}:d=1.2`
        : ''
      parts.push(`[${idx}:a]volume=${music.volume}${fade},apad[m]`)
      mixIn.push('[m]')
      idx++
    }
    if (vo) {
      parts.push(`[${idx}:a]volume=${vo.volume},apad[v]`)
      mixIn.push('[v]')
    }
    const mix =
      mixIn.length === 2
        ? `${mixIn.join('')}amix=inputs=2:duration=longest:dropout_transition=0[a]`
        : `${mixIn[0]}anull[a]`
    args.push('-filter_complex', [...parts, mix].join(';'))
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
  if (music || vo) args.push('-c:a', 'aac', '-b:a', '160k')
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
