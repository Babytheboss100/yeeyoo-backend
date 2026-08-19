import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProject } from '../src/mediaEngine/composer/vendor/v0.3.1/schema.js'
import { buildFfmpegArgs } from '../src/mediaEngine/composer/vendor/v0.3.1/encode.js'
import { fittedPlacement } from '../src/mediaEngine/composer/vendor/v0.3.1/geometry.js'
import { createArtifactVideoInputResolver } from '../src/mediaEngine/genome/videoInputResolver.js'
import fs from 'node:fs'

function baseProject(element, extra = {}) {
  return {
    schemaVersion: 1,
    kind: 'reel',
    canvas: { width: 100, height: 100, fps: 30, background: '#000' },
    scenes: [{ id: 's1', duration: 2, transition: { type: 'none', duration: 0 }, elements: element ? [element] : [] }],
    captions: [],
    audio: null,
    ...extra,
  }
}

function imageElement(extra = {}) {
  return {
    id: 'hero', type: 'image', assetId: 'hero-asset', x: 0.5, y: 0.5,
    w: 1, h: 1, fit: 'cover', opacity: 1, rotation: 0, style: {},
    in: { type: 'none', delay: 0, duration: 0 }, out: { type: 'none', duration: 0 }, animate: [],
    ...extra,
  }
}

test('clip audio is opt-in and ducking fails closed without voiceover and a bed', () => {
  const video = { ...imageElement(), type: 'video', audio: true }
  const valid = validateProject(baseProject(video, {
    audio: {
      voiceover: { assetId: 'vo' },
      ducking: { enabled: true },
    },
  }))
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.project.scenes[0].elements[0].audio, { enabled: true, volume: 1 })
  assert.deepEqual(valid.project.audio.ducking, {
    enabled: true, threshold: 0.05, ratio: 8, attackMs: 20, releaseMs: 250,
  })

  const noVoice = validateProject(baseProject(null, {
    audio: { music: { assetId: 'music' }, ducking: { enabled: true } },
  }))
  assert.equal(noVoice.ok, false)
  assert.ok(noVoice.errors.some(error => error.code === 'DUCKING_REQUIRES_VOICEOVER'))

  const noBed = validateProject(baseProject(null, {
    audio: { voiceover: { assetId: 'vo' }, ducking: { enabled: true } },
  }))
  assert.equal(noBed.ok, false)
  assert.ok(noBed.errors.some(error => error.code === 'DUCKING_REQUIRES_BED'))
})

test('FFmpeg graph trims and delays opted-in clip audio and ducks beds under voiceover', () => {
  const args = buildFfmpegArgs({
    width: 1080, height: 1920, fps: 30, duration: 6, outPath: '/tmp/out.mp4',
    audio: {
      music: { path: '/assets/music.wav', volume: 0.3, fadeOut: false },
      voiceover: { path: '/assets/vo.wav', volume: 1 },
      clips: [{ path: '/assets/clip.mp4', volume: 0.7, srcStart: 1.25, srcEnd: 3.5, delaySeconds: 2 }],
      ducking: { enabled: true, threshold: 0.05, ratio: 8, attackMs: 20, releaseMs: 250 },
    },
  })
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /\[3:a\]atrim=start=1\.25:end=3\.5,asetpts=PTS-STARTPTS,volume=0\.7,adelay=2000:all=1,apad\[c0\]/)
  assert.match(filter, /\[m\]\[c0\]amix=inputs=2:duration=longest:dropout_transition=0\[bed\]/)
  assert.match(filter, /\[v\]asplit=2\[vside\]\[vmix\]/)
  assert.match(filter, /\[bed\]\[vside\]sidechaincompress=threshold=0\.05:ratio=8:attack=20:release=250\[ducked\]/)
  assert.equal(args.filter(value => value === '-i').length, 4, 'raw video + music + voiceover + clip')
  assert.ok(args.includes('/assets/clip.mp4'))
})

test('image focal point controls cover crop while remaining schema-bounded', () => {
  const input = baseProject(imageElement({ focalPoint: { x: 1, y: 0.25 } }))
  const checked = validateProject(input)
  assert.equal(checked.ok, true)

  const placement = fittedPlacement({
    imageWidth: 200, imageHeight: 100,
    x: -50, y: -50, width: 100, height: 100,
    fit: 'cover', focalPoint: checked.project.scenes[0].elements[0].focalPoint,
  })
  assert.deepEqual(placement, { x: -150, y: -50, width: 200, height: 100, clip: true })

  const rejected = validateProject(baseProject(imageElement({ focalPoint: { x: 1.1, y: 0.5 } })))
  assert.equal(rejected.ok, false)
  assert.ok(rejected.errors.some(error => error.code === 'BAD_FOCAL_POINT'))
})

test('font registry contract requires asset identity, unique family and sha256 provenance', () => {
  const sha = 'a'.repeat(64)
  const valid = validateProject(baseProject(null, {
    fonts: [{ family: 'YeeYoo Sans', assetId: 'font-1', sha256: sha }],
  }))
  assert.equal(valid.ok, true)

  const invalid = validateProject(baseProject(null, {
    fonts: [
      { family: 'YeeYoo Sans', assetId: 'font-1', sha256: 'not-a-checksum' },
      { family: 'YeeYoo Sans', assetId: 'font-2', sha256: sha },
    ],
  }))
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.some(error => error.code === 'BAD_FONT_CHECKSUM'))
  assert.ok(invalid.errors.some(error => error.code === 'DUPLICATE_FONT_FAMILY'))
})

test('runtime font family is checksum-isolated across tenants', () => {
  const source = fs.readFileSync(new URL('../src/mediaEngine/composer/vendor/v0.3.1/assets.js', import.meta.url), 'utf8')
  assert.match(source, /runtimeFamily = `\$\{family\}__\$\{sha256\.slice\(0, 16\)\}`/)
  assert.match(source, /GlobalFonts\.registerFromPath\(path, runtimeFamily\)/)
  assert.match(source, /applyRegisteredFonts/)
  assert.doesNotMatch(source, /registeredFamilies\.get\(family\)/)
})

test('canonical artifact resolver binds approved font bytes to project checksum', async () => {
  const sha = 'a'.repeat(64)
  const project = baseProject(null, {
    fonts: [{ family: 'YeeYoo Sans', assetId: 'font-1', sha256: sha }],
  })
  const row = {
    id: 'font-1', user_id: 'u1', project_id: 'p1', status: 'approved', approval_current: true,
    content: { media: { kind: 'font', objectRef: `media/${sha}.ttf`, mimeType: 'font/ttf', sha256: sha } },
    provenance: {}, checksum_version: 'yeeyoo.artifact.legacy-pg-jsonb.v1',
    content_checksum: 'b'.repeat(64), output_checksum: sha,
  }
  const resolver = createArtifactVideoInputResolver({ db: { query: async () => ({ rows: [row] }) } })
  const result = await resolver({ userId: 'u1', projectId: 'p1', input: { project } })
  assert.deepEqual(result.assetBindings['font-1'], {
    objectRef: `media/${sha}.ttf`, mimeType: 'font/ttf', sha256: sha,
  })

  const stale = { ...project, fonts: [{ ...project.fonts[0], sha256: 'c'.repeat(64) }] }
  await assert.rejects(resolver({ userId: 'u1', projectId: 'p1', input: { project: stale } }), {
    code: 'STALE_VIDEO_ASSET',
  })
})
