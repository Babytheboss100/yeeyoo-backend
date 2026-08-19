import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createWorkerRequest, validateHandlerOutput, validateWorkerRequest, WORKER_SCHEMA_VERSION } from '../src/mediaEngine/contracts/workerApi.js'
import { assertProviderAdapter, PROVIDER_ADAPTER_CONTRACT_VERSION, PROVIDER_ADAPTER_SIGNATURE, ProviderAdapterError } from '../src/mediaEngine/contracts/provider.js'
import { createFakeImageProvider } from '../src/mediaEngine/providers/fakeProvider.js'
import { createSelfhostImageProvider } from '../src/mediaEngine/providers/selfhostImage.js'

const JOB_REF = '11111111-1111-4111-8111-111111111111'

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, checksum])
}

const requestInput = (overrides = {}) => ({
  jobRef: JOB_REF,
  prompt: 'A restrained Nordic fintech campaign hero',
  width: 1024,
  height: 1024,
  seed: 42,
  ...overrides,
})

test('ProviderAdapter v1 signature is explicit and frozen', () => {
  assert.equal(PROVIDER_ADAPTER_CONTRACT_VERSION, 'yeeyoo.media.provider.v1')
  assert.equal(Object.isFrozen(PROVIDER_ADAPTER_SIGNATURE), true)
  assert.deepEqual(Object.keys(PROVIDER_ADAPTER_SIGNATURE), ['capabilities', 'estimateCost', 'submit', 'getStatus', 'cancel', 'normalizeResult'])
})

test('worker request is versioned, normalized and hash bound', () => {
  const request = createWorkerRequest(requestInput({ prompt: '  campaign hero  ' }))
  assert.equal(request.schemaVersion, WORKER_SCHEMA_VERSION)
  assert.equal(request.prompt, 'campaign hero')
  assert.equal(request.requestHash.length, 64)
  assert.throws(() => validateWorkerRequest({ ...request, seed: 43 }), { code: 'REQUEST_HASH_MISMATCH' })
  assert.throws(() => validateWorkerRequest({ ...request, callbackUrl: 'https://attacker.invalid' }), { code: 'INVALID_WORKER_PAYLOAD' })
  assert.throws(() => createWorkerRequest(requestInput({ prompt: 'invalid\ud800text' })), { code: 'INVALID_WORKER_PAYLOAD' })
})

test('worker request locks model, generation step bounds, dimensions and seed', () => {
  assert.equal(createWorkerRequest(requestInput()).steps, 8)
  assert.equal(createWorkerRequest(requestInput({ steps: 12 })).steps, 12)
  assert.throws(() => createWorkerRequest(requestInput({ steps: 0 })), { code: 'INVALID_WORKER_PAYLOAD' })
  assert.throws(() => createWorkerRequest(requestInput({ steps: 13 })), { code: 'INVALID_WORKER_PAYLOAD' })
  assert.throws(() => createWorkerRequest(requestInput({ model: 'untrusted-model' })), { code: 'MODEL_UNAVAILABLE' })
  assert.throws(() => createWorkerRequest(requestInput({ width: 1000 })), { code: 'INVALID_WORKER_PAYLOAD' })
  assert.throws(() => createWorkerRequest(requestInput({ seed: -1 })), { code: 'INVALID_WORKER_PAYLOAD' })
})

test('worker output contract preserves a checksum-bound objectRef transport', () => {
  const request = createWorkerRequest(requestInput())
  const payload = {
    schemaVersion: request.schemaVersion,
    jobRef: request.jobRef,
    requestHash: request.requestHash,
    output: {
      transport: 'object_ref', mimeType: 'image/png', objectRef: `media/${'a'.repeat(64)}.png`,
      width: request.width, height: request.height, sizeBytes: 1234, sha256: 'a'.repeat(64),
    },
    provenance: { model: request.model, modelRevision: 'worker-v0.1', seed: request.seed, steps: request.steps, runtime: 'selfhost' },
    timings: {
      queueMs: 0, loadMs: 0, inferenceMs: 1, handlerTotalMs: 1, gpuActiveSeconds: 0,
      sources: { queueMs: 'provider', loadMs: 'worker_observed', inferenceMs: 'worker_observed', handlerTotalMs: 'worker_observed', gpuActiveSeconds: 'worker_observed' },
    },
  }
  assert.equal(validateHandlerOutput(payload, { expectedRequest: request }).output.objectRef, payload.output.objectRef)
  assert.throws(() => validateHandlerOutput({ ...payload, output: { ...payload.output, objectRef: '../foreign.png' } }, { expectedRequest: request }), { code: 'RESULT_INVALID' })
})

test('fake provider implements the frozen adapter and produces a validated deterministic result', async () => {
  const provider = createFakeImageProvider()
  assert.equal(assertProviderAdapter(provider), provider)
  assert.deepEqual(provider.capabilities().models, ['z-image-turbo'])
  assert.equal(provider.estimateCost().billable, false)

  const request = createWorkerRequest(requestInput())
  const first = await provider.submit(request)
  const replay = await provider.submit(request)
  assert.equal(replay.providerJobId, first.providerJobId)
  assert.equal((await provider.getStatus(first.providerJobId)).state, 'processing')
  const completed = await provider.getStatus(first.providerJobId)
  assert.equal(completed.state, 'succeeded')
  assert.equal(completed.result.output.mimeType, 'image/png')
  assert.equal(validateHandlerOutput(completed.result, { expectedRequest: request }).requestHash, request.requestHash)
})

test('providers validate prebuilt worker requests before any submission', async () => {
  const request = createWorkerRequest(requestInput())
  const tampered = { ...request, seed: 43 }
  await assert.rejects(createFakeImageProvider().submit(tampered), { code: 'REQUEST_HASH_MISMATCH' })

  let called = false
  const selfhost = createSelfhostImageProvider({
    baseUrl: 'http://127.0.0.1:8787',
    serviceToken: 'test-service-token-123',
    fetchImpl: async () => { called = true },
  })
  await assert.rejects(selfhost.submit(tampered), { code: 'REQUEST_HASH_MISMATCH' })
  assert.equal(called, false)
})

test('fake provider rejects idempotency key reuse with changed input', async () => {
  const provider = createFakeImageProvider()
  await provider.submit(createWorkerRequest(requestInput()))
  await assert.rejects(provider.submit(createWorkerRequest(requestInput({ prompt: 'Different input' }))), { code: 'IDEMPOTENCY_CONFLICT' })
})

test('fake cancellation is idempotent and terminal completion wins a late cancel race', async () => {
  const provider = createFakeImageProvider()
  const pending = await provider.submit(createWorkerRequest(requestInput()))
  assert.equal((await provider.cancel(pending.providerJobId)).state, 'cancelled')
  assert.equal((await provider.cancel(pending.providerJobId)).state, 'cancelled')

  const completedProvider = createFakeImageProvider()
  const completedJob = await completedProvider.submit(createWorkerRequest(requestInput()))
  await completedProvider.getStatus(completedJob.providerJobId)
  await completedProvider.getStatus(completedJob.providerJobId)
  assert.equal((await completedProvider.cancel(completedJob.providerJobId)).state, 'succeeded')
})

test('fake failure scenarios are configured by the server, not request input', async () => {
  const provider = createFakeImageProvider({ scenarioForRequest: () => 'timed_out' })
  const submitted = await provider.submit(createWorkerRequest(requestInput()))
  await provider.getStatus(submitted.providerJobId)
  const terminal = await provider.getStatus(submitted.providerJobId)
  assert.equal(terminal.state, 'timed_out')
  assert.equal(terminal.error.code, 'PROVIDER_TIMEOUT')
})

test('fake provider capacity is bounded without breaking idempotent replay', async () => {
  const provider = createFakeImageProvider({ maxJobs: 1 })
  const request = createWorkerRequest(requestInput())
  const first = await provider.submit(request)
  assert.equal((await provider.submit(request)).providerJobId, first.providerJobId)
  await assert.rejects(provider.submit(createWorkerRequest(requestInput({ jobRef: '22222222-2222-4222-8222-222222222222' }))), { code: 'RATE_LIMITED', retryable: true })
})

test('fake provider evicts terminal records after its bounded retention window', async () => {
  let now = 0
  const provider = createFakeImageProvider({ maxJobs: 1, terminalTtlMs: 10, clockMs: () => now })
  const first = await provider.submit(createWorkerRequest(requestInput()))
  await provider.cancel(first.providerJobId)
  now = 11
  const second = await provider.submit(createWorkerRequest(requestInput({ jobRef: '22222222-2222-4222-8222-222222222222' })))
  assert.notEqual(second.providerJobId, first.providerJobId)
})

test('completed inline PNG must have valid chunks, CRC, compressed data and IEND', async () => {
  const provider = createFakeImageProvider()
  const request = createWorkerRequest(requestInput())
  const submitted = await provider.submit(request)
  await provider.getStatus(submitted.providerJobId)
  const completed = await provider.getStatus(submitted.providerJobId)
  const original = Buffer.from(completed.result.output.dataBase64, 'base64')
  const truncated = original.subarray(0, original.length - 12)
  const output = {
    ...completed.result.output,
    dataBase64: truncated.toString('base64'),
    sizeBytes: truncated.length,
    sha256: crypto.createHash('sha256').update(truncated).digest('hex'),
  }
  assert.throws(() => validateHandlerOutput({ ...completed.result, output }, { expectedRequest: request }), { code: 'RESULT_INVALID' })

  const badCrc = Buffer.from(original)
  badCrc.writeUInt32BE(0, 29)
  const crcOutput = {
    ...completed.result.output,
    dataBase64: badCrc.toString('base64'),
    sha256: crypto.createHash('sha256').update(badCrc).digest('hex'),
  }
  assert.throws(() => validateHandlerOutput({ ...completed.result, output: crcOutput }, { expectedRequest: request }), { code: 'RESULT_INVALID' })

  let offset = 8
  while (original.toString('ascii', offset + 4, offset + 8) !== 'IDAT') offset += 12 + original.readUInt32BE(offset)
  const oldLength = original.readUInt32BE(offset)
  const type = original.subarray(offset + 4, offset + 8)
  const data = Buffer.concat([original.subarray(offset + 8, offset + 8 + oldLength), Buffer.from([0])])
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  const chunk = Buffer.concat([length, type, data, checksum])
  const trailingCompressed = Buffer.concat([original.subarray(0, offset), chunk, original.subarray(offset + 12 + oldLength)])
  const trailingOutput = {
    ...completed.result.output,
    dataBase64: trailingCompressed.toString('base64'),
    sizeBytes: trailingCompressed.length,
    sha256: crypto.createHash('sha256').update(trailingCompressed).digest('hex'),
  }
  assert.throws(() => validateHandlerOutput({ ...completed.result, output: trailingOutput }, { expectedRequest: request }), { code: 'RESULT_INVALID' })

  const grayscaleHeader = Buffer.alloc(13)
  grayscaleHeader.writeUInt32BE(1024, 0)
  grayscaleHeader.writeUInt32BE(1024, 4)
  grayscaleHeader[8] = 8
  grayscaleHeader[9] = 0
  const grayscaleWithForbiddenPalette = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', grayscaleHeader),
    pngChunk('PLTE', Buffer.from([0, 0, 0])),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(1025 * 1024))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  const paletteOutput = {
    ...completed.result.output,
    dataBase64: grayscaleWithForbiddenPalette.toString('base64'),
    sizeBytes: grayscaleWithForbiddenPalette.length,
    sha256: crypto.createHash('sha256').update(grayscaleWithForbiddenPalette).digest('hex'),
  }
  assert.throws(() => validateHandlerOutput({ ...completed.result, output: paletteOutput }, { expectedRequest: request }), { code: 'RESULT_INVALID' })
})

test('selfhost adapter speaks the frozen control-plane contract without exposing service credentials', async () => {
  const fake = createFakeImageProvider()
  const request = createWorkerRequest(requestInput())
  const fakeJob = await fake.submit(request)
  await fake.getStatus(fakeJob.providerJobId)
  const fakeCompleted = await fake.getStatus(fakeJob.providerJobId)
  const calls = []
  const responses = [
    { id: 'worker-job-1', status: 'IN_QUEUE' },
    { id: 'worker-job-1', status: 'COMPLETED', delayTime: 3, executionTime: 7, usage: { gpu_seconds: 0.5, billable: true }, output: fakeCompleted.result },
    { id: 'worker-job-1', status: 'COMPLETED' },
  ]
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const body = responses.shift()
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
  }
  const provider = createSelfhostImageProvider({ baseUrl: 'http://127.0.0.1:8787', serviceToken: 'test-service-token-123', fetchImpl })
  const submitted = await provider.submit(request)
  const completed = await provider.getStatus(submitted.providerJobId)
  assert.equal(completed.state, 'succeeded')
  assert.equal(completed.providerMetrics.executionMs, 7)
  assert.equal(completed.providerMetrics.gpuSeconds, 0.5)
  assert.equal(completed.providerMetrics.billable, true)
  assert.deepEqual(JSON.parse(calls[0].options.body), { input: request })
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-service-token-123')
  assert.doesNotMatch(JSON.stringify(completed), /test-service-token/)
  assert.equal((await provider.cancel(submitted.providerJobId)).state, 'succeeded')
})

test('selfhost adapter bounds HTTP errors and rejects insecure remote URLs', async () => {
  assert.throws(() => createSelfhostImageProvider({ baseUrl: 'http://example.com', serviceToken: 'test-service-token-123' }), TypeError)
  assert.throws(() => createSelfhostImageProvider({ baseUrl: 'http://127.0.0.1', serviceToken: ' test-service-token-123' }), TypeError)
  const provider = createSelfhostImageProvider({
    baseUrl: 'https://worker.example.com',
    serviceToken: 'test-service-token-123',
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'secret provider body' }),
  })
  await assert.rejects(provider.submit(createWorkerRequest(requestInput())), error => error instanceof ProviderAdapterError && error.code === 'RATE_LIMITED' && !error.message.includes('secret'))
})

test('selfhost submit accepts idempotent terminal replay and preserves retryable worker failure semantics', async () => {
  const request = createWorkerRequest(requestInput())
  const responses = [
    { id: 'worker-terminal-1', status: 'COMPLETED' },
    { id: 'worker-terminal-1', status: 'FAILED', error: { code: 'INFERENCE_FAILED', message: 'private detail', retryable: true } },
  ]
  const provider = createSelfhostImageProvider({
    baseUrl: 'http://127.0.0.1:8787',
    serviceToken: 'test-service-token-123',
    maxTrackedRequests: 1,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(responses.shift()) }),
  })
  assert.equal((await provider.submit(request)).providerJobId, 'worker-terminal-1')
  const failed = await provider.getStatus('worker-terminal-1', request)
  assert.deepEqual(failed.error, { code: 'PROVIDER_TEMPORARY', message: 'Image worker failed', retryable: true })
})
