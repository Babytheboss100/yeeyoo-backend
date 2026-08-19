// yeeyoo-media-composer — output-verifikasjon (v0.2, P0.4)
// Etter encoding: ffprobe + checksum. Composer erklærer ALDRI suksess bare
// fordi FFmpeg returnerte 0 — filen må bevises gyldig mot prosjektet.

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { probeMedia } from './videoFrames.js'

export async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/**
 * verifyOutput(path, { width, height, fps, duration, expectAudio, ffprobePath })
 * → { probe, sha256, sizeBytes } eller kaster med presis grunn.
 */
export async function verifyOutput(path, expected) {
  const st = statSync(path)
  if (st.size < 1024) throw new Error(`output er mistenkelig liten (${st.size} bytes)`)

  const probe = await probeMedia(path, { ffprobePath: expected.ffprobePath ?? 'ffprobe', signal: expected.signal })
  const fail = msg => { throw new Error(`output-verifikasjon feilet: ${msg}`) }

  if (probe.codec !== 'h264') fail(`codec ${probe.codec}, forventet h264`)
  if (probe.width !== expected.width || probe.height !== expected.height)
    fail(`${probe.width}x${probe.height}, forventet ${expected.width}x${expected.height}`)
  if (!Number.isFinite(probe.durationSec)) fail('varighet kunne ikke leses')
  const dur = probe.durationSec
  if (Math.abs(dur - expected.duration) > 0.25)
    fail(`varighet ${dur.toFixed(2)}s, forventet ${expected.duration.toFixed(2)}s ±0.25`)
  if (expected.expectAudio && !probe.hasAudio) fail('lydspor mangler')
  if (!expected.expectAudio && probe.hasAudio) fail('uventet lydspor')

  const sha256 = await sha256File(path)
  return { probe, sha256, sizeBytes: st.size }
}
