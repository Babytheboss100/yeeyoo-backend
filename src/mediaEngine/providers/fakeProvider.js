import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { assertProviderAdapter, ProviderAdapterError } from '../contracts/provider.js'
import { createWorkerRequest, validateHandlerOutput, validateWorkerRequest, Z_IMAGE_TURBO, Z_IMAGE_TURBO_STEPS } from '../contracts/workerApi.js'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function deterministicPng(request) {
  const digest = Buffer.from(request.requestHash, 'hex')
  const rowSize = request.width * 3 + 1
  const raw = Buffer.alloc(rowSize * request.height)
  for (let y = 0; y < request.height; y += 1) {
    const row = y * rowSize
    raw[row] = 0
    const stripe = Math.floor(y / 32) % 2
    for (let x = 0; x < request.width; x += 1) {
      const offset = row + 1 + x * 3
      const accent = (Math.floor(x / 32) + stripe) % 2 ? 24 : 0
      raw[offset] = (digest[0] + accent) & 0xff
      raw[offset + 1] = (digest[1] + accent) & 0xff
      raw[offset + 2] = (digest[2] + accent) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(request.width, 0)
  header.writeUInt32BE(request.height, 4)
  header[8] = 8
  header[9] = 2
  const png = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))])
  return { png, sha256: crypto.createHash('sha256').update(png).digest('hex') }
}

function fakeHandlerOutput(request) {
  const { png, sha256 } = deterministicPng(request)
  return {
    schemaVersion: request.schemaVersion,
    jobRef: request.jobRef,
    requestHash: request.requestHash,
    output: {
      transport: 'inline_base64',
      mimeType: 'image/png',
      dataBase64: png.toString('base64'),
      width: request.width,
      height: request.height,
      sizeBytes: png.length,
      sha256,
    },
    provenance: { model: request.model, modelRevision: 'fake-z-image-turbo-v1', seed: request.seed, steps: request.steps, runtime: 'fake-v1' },
    timings: {
      queueMs: 0,
      loadMs: 0,
      inferenceMs: 0,
      handlerTotalMs: 0,
      gpuActiveSeconds: 0,
      sources: { queueMs: 'provider', loadMs: 'worker_observed', inferenceMs: 'worker_observed', handlerTotalMs: 'worker_observed', gpuActiveSeconds: 'worker_observed' },
    },
  }
}

export function createFakeImageProvider({ scenarioForRequest = () => 'success', maxJobs = 1_000, terminalTtlMs = 15 * 60 * 1000, clockMs = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100_000) throw new TypeError('Fake image provider maxJobs is invalid')
  if (!Number.isSafeInteger(terminalTtlMs) || terminalTtlMs < 1 || terminalTtlMs > 24 * 60 * 60 * 1000) throw new TypeError('Fake image provider terminalTtlMs is invalid')
  if (typeof clockMs !== 'function') throw new TypeError('Fake image provider clockMs is invalid')
  const jobs = new Map()
  const submissions = new Map()

  function purgeExpiredTerminal() {
    const now = clockMs()
    for (const [providerJobId, job] of jobs) {
      if (job.finishedAtMs == null || now - job.finishedAtMs < terminalTtlMs) continue
      jobs.delete(providerJobId)
      submissions.delete(job.request.jobRef)
    }
  }

  function finish(job, state, { error, output } = {}) {
    job.state = state
    job.error = error || null
    job.output = output || null
    job.finishedAtMs = clockMs()
  }

  const adapter = {
    name: 'fake-image',
    capabilities() {
      return { operations: ['image.generate'], models: [Z_IMAGE_TURBO], aspects: ['1:1', '7:9', '9:7', '4:7', '7:4'], tier: 'standard' }
    },
    estimateCost() {
      return { estimatedUsd: '0.000000', currency: 'USD', basis: 'fake', billable: false }
    },
    async submit(input) {
      purgeExpiredTerminal()
      const request = input?.schemaVersion ? validateWorkerRequest(input) : createWorkerRequest(input)
      const existing = submissions.get(request.jobRef)
      if (existing) {
        if (existing.requestHash !== request.requestHash) throw new ProviderAdapterError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different input')
        return { providerJobId: existing.providerJobId }
      }
      if (jobs.size >= maxJobs) throw new ProviderAdapterError('RATE_LIMITED', 'Fake image worker capacity is exhausted', { retryable: true })
      const providerJobId = `fake-${crypto.randomUUID()}`
      const scenario = scenarioForRequest(Object.freeze({ jobRef: request.jobRef, requestHash: request.requestHash }))
      jobs.set(providerJobId, { providerJobId, request, scenario, state: 'queued', polls: 0, output: null, error: null, finishedAtMs: null })
      submissions.set(request.jobRef, { providerJobId, requestHash: request.requestHash })
      return { providerJobId }
    },
    async getStatus(providerJobId) {
      purgeExpiredTerminal()
      const job = jobs.get(providerJobId)
      if (!job) return { providerJobId, state: 'expired', error: { code: 'RESULT_EXPIRED', message: 'Fake worker result expired', retryable: false } }
      if (['cancelled', 'failed', 'timed_out', 'succeeded'].includes(job.state)) return terminalStatus(job)
      job.polls += 1
      if (job.polls === 1) {
        job.state = 'processing'
        return { providerJobId, state: 'processing' }
      }
      if (job.scenario === 'failed') {
        finish(job, 'failed', { error: { code: 'PROVIDER_PERMANENT', message: 'Fake worker failed', retryable: false } })
      } else if (job.scenario === 'timed_out') {
        finish(job, 'timed_out', { error: { code: 'PROVIDER_TIMEOUT', message: 'Fake worker timed out', retryable: true } })
      } else {
        finish(job, 'succeeded', { output: validateHandlerOutput(fakeHandlerOutput(job.request), { expectedRequest: job.request }) })
      }
      return terminalStatus(job)
    },
    async cancel(providerJobId) {
      purgeExpiredTerminal()
      const job = jobs.get(providerJobId)
      if (!job) return { providerJobId, state: 'expired' }
      if (job.state === 'succeeded') return { providerJobId, state: 'succeeded' }
      if (!['failed', 'timed_out', 'cancelled'].includes(job.state)) finish(job, 'cancelled')
      return { providerJobId, state: job.state }
    },
    normalizeResult(payload, expectedRequest) {
      return validateHandlerOutput(payload, { expectedRequest })
    },
  }
  return Object.freeze(assertProviderAdapter(adapter))
}

function terminalStatus(job) {
  return {
    providerJobId: job.providerJobId,
    state: job.state,
    ...(job.output ? { result: job.output } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

export const FAKE_IMAGE_MODEL = Object.freeze({ id: Z_IMAGE_TURBO, revision: 'fake-z-image-turbo-v1', steps: Z_IMAGE_TURBO_STEPS })
