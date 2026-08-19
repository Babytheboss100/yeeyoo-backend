// End-to-end native render: real @napi-rs/canvas frames through real FFmpeg to
// a real MP4 on disk. Everything else in the composer suite injects composeVideo
// or only builds argument lists, so this is the only place the native pipeline
// is actually exercised. Skips itself when the native toolchain is unavailable
// rather than failing a machine that legitimately lacks FFmpeg.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binaryWorks = bin => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false }
}

let canvasModule = null
try { canvasModule = await import('@napi-rs/canvas') } catch { canvasModule = null }

const missing = [
  binaryWorks('ffmpeg') ? null : 'ffmpeg',
  binaryWorks('ffprobe') ? null : 'ffprobe',
  canvasModule ? null : '@napi-rs/canvas',
].filter(Boolean)

const native = { skip: missing.length ? `native render toolchain unavailable: ${missing.join(', ')}` : false }

const { composeVideo } = await import('../src/mediaEngine/composer/vendor/v0.3.1/compose.js')

const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const CANVAS = { width: 160, height: 284, fps: 30, background: '#101018' }
const DURATION = 0.4 // seconds; 12 frames is enough to exercise the pipeline

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yeeyoo-native-render-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function textProject() {
  return {
    schemaVersion: 1,
    kind: 'reel',
    canvas: { ...CANVAS },
    scenes: [{
      id: 'scene-1',
      duration: DURATION,
      elements: [
        { id: 'title', type: 'text', text: 'YEEYOO', x: 0.5, y: 0.45, style: { fontSize: 0.12, color: '#ffffff' }, in: { type: 'fade', delay: 0, duration: 0.3 } },
        { id: 'bar', type: 'rect', x: 0.5, y: 0.7, w: 0.6, h: 0.02, style: { color: '#00e5ff' } },
      ],
    }],
    captions: [{ text: 'native render', start: 0.05, end: 0.35, style: {} }],
    audio: null,
  }
}

test('native render produces a probe-verified H.264 MP4 whose checksum matches the bytes on disk', native, async t => {
  const outPath = join(workspace(t), 'out.mp4')
  const result = await composeVideo(textProject(), { outPath })

  assert.equal(result.outPath, outPath)
  assert.ok(existsSync(outPath), 'the encoder must leave a file at outPath')

  // The reported checksum must describe the bytes that actually landed on disk:
  // the whole approval/publishing chain is bound to this value.
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.sha256, sha256File(outPath))
  assert.equal(result.sizeBytes, readFileSync(outPath).length)

  // Real MP4 container, not an empty or truncated file.
  const head = readFileSync(outPath).subarray(0, 12)
  assert.equal(head.subarray(4, 8).toString('latin1'), 'ftyp', 'output must carry the MP4 ftyp box')
  assert.ok(result.sizeBytes > 1024, `expected a non-trivial file, got ${result.sizeBytes} bytes`)

  // What FFprobe reports must match what the project asked for.
  assert.equal(result.probe.codec, 'h264')
  assert.equal(result.probe.width, CANVAS.width)
  assert.equal(result.probe.height, CANVAS.height)
  assert.equal(result.probe.frameRate, `${CANVAS.fps}/1`)
  assert.equal(result.probe.hasAudio, false)
  assert.ok(Math.abs(result.probe.durationSec - DURATION) < 0.15, `duration ${result.probe.durationSec} should be about ${DURATION}s`)
  assert.equal(result.totalFrames, Math.round(DURATION * CANVAS.fps))
})

test('an identical project renders byte-identical output', native, async t => {
  const dir = workspace(t)
  const first = await composeVideo(textProject(), { outPath: join(dir, 'a.mp4') })
  const second = await composeVideo(textProject(), { outPath: join(dir, 'b.mp4') })

  // Determinism is what makes the content checksum a meaningful contract: the
  // same project must never produce a different digest.
  assert.equal(first.sha256, second.sha256)
  assert.equal(first.sizeBytes, second.sizeBytes)
})

test('real image, focal point, registered font and ducked audio survive a native render', native, async t => {
  const dir = workspace(t)

  const canvas = canvasModule.createCanvas(200, 200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff8800'; ctx.fillRect(0, 0, 200, 200)
  ctx.fillStyle = '#003366'; ctx.fillRect(120, 20, 60, 60)
  const imagePath = join(dir, 'image.png')
  writeFileSync(imagePath, canvas.toBuffer('image/png'))

  const musicPath = join(dir, 'music.wav')
  const voicePath = join(dir, 'voice.wav')
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.6', '-ac', '2', musicPath], { stdio: 'ignore' })
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.6', '-ac', '2', voicePath], { stdio: 'ignore' })

  const systemFont = 'C:/Windows/Fonts/arial.ttf'
  const hasFont = existsSync(systemFont)
  const fontPath = join(dir, 'brand.ttf')
  if (hasFont) copyFileSync(systemFont, fontPath)

  const project = {
    schemaVersion: 1,
    kind: 'reel',
    canvas: { ...CANVAS },
    fonts: hasFont ? [{ family: 'BrandFont', assetId: 'font-1', sha256: sha256File(fontPath) }] : [],
    scenes: [{
      id: 'scene-1',
      duration: DURATION,
      elements: [
        { id: 'photo', type: 'image', assetId: 'image-1', x: 0.5, y: 0.35, w: 0.8, fit: 'cover', focalPoint: { x: 0.8, y: 0.15 } },
        { id: 'title', type: 'text', text: 'YEEYOO', x: 0.5, y: 0.75, style: { fontSize: 0.1, color: '#ffffff', ...(hasFont ? { fontFamily: 'BrandFont' } : {}) } },
      ],
    }],
    captions: [],
    audio: {
      music: { assetId: 'music-1', volume: 0.4 },
      voiceover: { assetId: 'voice-1', volume: 1 },
      ducking: { enabled: true, threshold: 0.05, ratio: 8, attackMs: 20, releaseMs: 250 },
    },
  }

  const assetMap = { 'image-1': imagePath, 'music-1': musicPath, 'voice-1': voicePath, ...(hasFont ? { 'font-1': fontPath } : {}) }
  const outPath = join(dir, 'p1.mp4')
  const result = await composeVideo(project, { outPath, assetMap })

  assert.equal(result.sha256, sha256File(outPath))
  assert.equal(result.probe.codec, 'h264')
  // Ducking mixes music under the voiceover, so the muxed file must carry audio.
  assert.equal(result.probe.hasAudio, true, 'ducked music + voiceover must produce an audio track')

  if (hasFont) {
    // The font registry binds the rendered family to the file's content, so a
    // swapped font file cannot silently reuse the same runtime family.
    assert.equal(result.fonts.length, 1)
    assert.equal(result.fonts[0].family, 'BrandFont')
    assert.equal(result.fonts[0].sha256, sha256File(fontPath))
    assert.match(result.fonts[0].runtimeFamily, /^BrandFont__[a-f0-9]{16}$/)
  }
})

test('a video clip with its audio enabled is decoded and muxed natively', native, async t => {
  const dir = workspace(t)
  const clipPath = join(dir, 'clip.mp4')
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=30:duration=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipPath,
  ], { stdio: 'ignore' })

  const project = {
    schemaVersion: 1,
    kind: 'reel',
    canvas: { ...CANVAS },
    scenes: [{
      id: 'scene-1',
      duration: DURATION,
      elements: [{ id: 'clip', type: 'video', assetId: 'clip-1', x: 0.5, y: 0.5, w: 1, fit: 'cover', srcStart: 0, audio: { enabled: true, volume: 1 } }],
    }],
    captions: [],
    audio: null,
  }

  const outPath = join(dir, 'clip-out.mp4')
  const result = await composeVideo(project, { outPath, assetMap: { 'clip-1': clipPath } })

  assert.equal(result.sha256, sha256File(outPath))
  assert.equal(result.probe.width, CANVAS.width)
  assert.equal(result.probe.hasAudio, true, 'clip audio was explicitly enabled and must reach the mix')
})

test('a cancelled native render terminates and leaves no output file behind', native, async t => {
  const dir = workspace(t)
  const outPath = join(dir, 'cancelled.mp4')
  const controller = new AbortController()

  const project = textProject()
  project.scenes[0].duration = 4 // long enough that cancellation lands mid-render

  const pending = composeVideo(project, {
    outPath,
    signal: controller.signal,
    onProgress: ({ frame }) => { if (frame >= 2) controller.abort() },
  })

  // The vendored composer signals cancellation with its own Norwegian message.
  await assert.rejects(pending, err => {
    assert.equal(err?.message, 'kansellert')
    return true
  })
  // Output is written atomically via a temp file, so a cancelled render must
  // never leave a partial MP4 at the destination.
  assert.equal(existsSync(outPath), false, 'a cancelled render must not leave a partial file at outPath')
})
