import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkerRequest } from '../src/mediaEngine/contracts/workerApi.js'
import { createSelfhostImageProvider } from '../src/mediaEngine/providers/selfhostImage.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKER_DIR = path.join(ROOT, 'services', 'media-worker')
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const SERVICE_TOKEN = 'cross-runtime-test-token-123'

function waitForReady(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error('Fake worker did not become ready')), timeoutMs)
    const onData = chunk => {
      stdout += chunk.toString('utf8')
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('READY '))
      if (!line) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      try { resolve(JSON.parse(line.slice(6))) } catch { reject(new Error('Fake worker emitted an invalid ready message')) }
    }
    child.stdout.on('data', onData)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Fake worker exited before ready (${code})`))
    })
  })
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

test('Node ProviderAdapter and Python fake worker share the frozen Unicode-safe v1 contract', { timeout: 15_000 }, async t => {
  const child = spawn(PYTHON, ['handler.py', '--serve', '--host', '127.0.0.1', '--port', '0'], {
    cwd: WORKER_DIR,
    env: { ...process.env, FAKE_EXECUTION: '1', MEDIA_WORKER_SERVICE_TOKEN: SERVICE_TOKEN, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => stopChild(child))
  child.stderr.on('data', () => {})
  const ready = await waitForReady(child)
  assert.ok(Number.isInteger(ready.port) && ready.port > 0)

  const provider = createSelfhostImageProvider({ baseUrl: `http://127.0.0.1:${ready.port}`, serviceToken: SERVICE_TOKEN, timeoutMs: 5_000 })
  const request = createWorkerRequest({
    jobRef: '22222222-2222-4222-8222-222222222222',
    prompt: 'Et troverdig norsk fintech-motiv – lønnsom vekst uten rå prompt i bildet',
    negativePrompt: 'feil tekst',
    width: 896,
    height: 1152,
    seed: 2026,
  })
  const submitted = await provider.submit(request)
  let status
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await provider.getStatus(submitted.providerJobId)
    if (!['queued', 'processing'].includes(status.state)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(status.state, 'succeeded')
  assert.equal(status.result.requestHash, request.requestHash)
  assert.equal(status.result.output.width, 896)
  assert.equal(status.result.output.height, 1152)
  assert.equal(status.result.provenance.runtime, 'fake-v1')
})

test('worker HTTP runtime fails closed when FAKE_EXECUTION is not explicitly enabled', { timeout: 15_000 }, async t => {
  const env = { ...process.env, MEDIA_WORKER_SERVICE_TOKEN: SERVICE_TOKEN, PYTHONDONTWRITEBYTECODE: '1' }
  delete env.FAKE_EXECUTION
  const child = spawn(PYTHON, ['handler.py', '--serve', '--host', '127.0.0.1', '--port', '0'], {
    cwd: WORKER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  t.after(() => stopChild(child))
  child.stderr.on('data', () => {})
  const ready = await waitForReady(child)
  const provider = createSelfhostImageProvider({ baseUrl: `http://127.0.0.1:${ready.port}`, serviceToken: SERVICE_TOKEN, timeoutMs: 5_000 })
  const request = createWorkerRequest({
    jobRef: '33333333-3333-4333-8333-333333333333', prompt: 'Locked real-mode test',
    width: 1024, height: 1024, seed: 1,
  })
  const submitted = await provider.submit(request)
  let status
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await provider.getStatus(submitted.providerJobId)
    if (!['queued', 'processing'].includes(status.state)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(status.state, 'failed')
  assert.equal(status.error.code, 'PROVIDER_PERMANENT')
  assert.equal(status.error.retryable, false)
})
