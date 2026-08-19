import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { extractClipFrames, runProcess } from '../src/mediaEngine/composer/vendor/v0.3.1/videoFrames.js'
import { createEncoder } from '../src/mediaEngine/composer/vendor/v0.3.1/encode.js'

function child({ stdout = '', closeCode = null, closeAfterKill = true } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kills = []
  proc.kill = signal => {
    proc.kills.push(signal)
    if (closeAfterKill) setImmediate(() => proc.emit('close', 137))
    return true
  }
  setImmediate(() => {
    if (stdout) proc.stdout.write(stdout)
    proc.stdout.end()
    proc.stderr.end()
    if (closeCode != null) proc.emit('close', closeCode)
  })
  return proc
}

test('runProcess abort kills child and resolves rejection only after close', async () => {
  const controller = new AbortController()
  let proc
  const promise = runProcess('ffmpeg', [], { signal: controller.signal, spawnImpl: () => (proc = child({ closeAfterKill: false })) })
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(proc.kills, ['SIGKILL'])
  let settled = false
  promise.catch(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  proc.emit('close', 137)
  await assert.rejects(promise, { code: 'CANCELLED' })
})

test('runProcess resource monitor kills and awaits child', async () => {
  let proc
  const limit = Object.assign(new Error('temp quota'), { code: 'RESOURCE_LIMIT' })
  const promise = runProcess('ffmpeg', [], {
    spawnImpl: () => (proc = child({ closeAfterKill: true })),
    tickMs: 1,
    onTick() { throw limit },
  })
  await assert.rejects(promise, error => error === limit)
  assert.deepEqual(proc.kills, ['SIGKILL'])
})

test('encoder abort kills FFmpeg and finish rejects only after child close', async () => {
  const controller = new AbortController()
  const proc = child({ closeAfterKill: false })
  proc.stdin = new PassThrough()
  const encoder = createEncoder({
    width: 16,
    height: 16,
    fps: 24,
    duration: 1,
    outPath: '/tmp/never-written.mp4',
    signal: controller.signal,
    spawnImpl: () => proc,
  })
  const finished = encoder.finish()
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(proc.kills, ['SIGKILL'])
  let settled = false
  finished.catch(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  proc.emit('close', 137)
  await assert.rejects(finished, { code: 'CANCELLED' })
})

test('extractClipFrames rejects source/frame bounds before extraction spawn', async () => {
  let spawns = 0
  const probeJson = JSON.stringify({
    format: { duration: '60', size: '1024' },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
  })
  const spawnImpl = () => {
    spawns += 1
    return child({ stdout: probeJson, closeCode: 0 })
  }
  await assert.rejects(extractClipFrames({
    inputPath: '/internal/source.mp4',
    outDir: '/tmp/not-created-because-frame-bound',
    fps: 30,
    windowSec: 10,
    maxW: 1080,
    maxH: 1920,
    maxFrames: 10,
    spawnImpl,
  }), { code: 'RESOURCE_LIMIT' })
  assert.equal(spawns, 1, 'ffprobe runs, extraction FFmpeg never starts')
})
