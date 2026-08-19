import crypto from 'node:crypto'
import zlib from 'node:zlib'

export const WORKER_SCHEMA_VERSION = 'yeeyoo.media.worker.v1'
export const IMAGE_OPERATION = 'image.generate'
export const Z_IMAGE_TURBO = 'z-image-turbo'
export const Z_IMAGE_TURBO_STEPS = 8
export const Z_IMAGE_TURBO_MAX_STEPS = 12
export const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024

export const ALLOWED_IMAGE_DIMENSIONS = Object.freeze([
  Object.freeze({ width: 1024, height: 1024, aspect: '1:1' }),
  Object.freeze({ width: 896, height: 1152, aspect: '7:9' }),
  Object.freeze({ width: 1152, height: 896, aspect: '9:7' }),
  Object.freeze({ width: 768, height: 1344, aspect: '4:7' }),
  Object.freeze({ width: 1344, height: 768, aspect: '7:4' }),
])

const DIMENSION_KEYS = new Set(ALLOWED_IMAGE_DIMENSIONS.map(({ width, height }) => `${width}x${height}`))
const REQUEST_FIELDS = new Set(['schemaVersion', 'operation', 'jobRef', 'requestHash', 'model', 'prompt', 'negativePrompt', 'width', 'height', 'seed', 'steps'])
const HANDLER_FIELDS = new Set(['schemaVersion', 'jobRef', 'requestHash', 'output', 'provenance', 'timings'])
const TIMING_FIELDS = new Set(['queueMs', 'loadMs', 'inferenceMs', 'handlerTotalMs', 'gpuActiveSeconds', 'sources'])
const SOURCE_FIELDS = new Set(['queueMs', 'loadMs', 'inferenceMs', 'handlerTotalMs', 'gpuActiveSeconds'])
const PROVENANCE_FIELDS = new Set(['model', 'modelRevision', 'seed', 'steps', 'runtime'])
const INLINE_OUTPUT_FIELDS = new Set(['transport', 'mimeType', 'dataBase64', 'width', 'height', 'sizeBytes', 'sha256'])
const OBJECT_OUTPUT_FIELDS = new Set(['transport', 'mimeType', 'objectRef', 'width', 'height', 'sizeBytes', 'sha256'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// Lone UTF-16 surrogates are rejected so Node and Python hash the exact same
// Unicode scalar values instead of applying runtime-specific replacement.
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export class WorkerContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkerContractError'
    this.code = code
    this.retryable = false
  }
}

const fail = (code, message) => { throw new WorkerContractError(code, message) }

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail('INVALID_WORKER_PAYLOAD', `${label} must be an object`)
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) fail('INVALID_WORKER_PAYLOAD', `${label} contains unsupported fields`)
}

function normalizedText(value, label, { required = false, maxChars = 2000, maxBytes = 8000 } = {}) {
  if (value == null && !required) return undefined
  if (typeof value !== 'string') fail('INVALID_WORKER_PAYLOAD', `${label} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (required && !normalized) fail('INVALID_WORKER_PAYLOAD', `${label} is required`)
  if (normalized.length > maxChars || Buffer.byteLength(normalized, 'utf8') > maxBytes || FORBIDDEN_CONTROL_RE.test(normalized)) {
    fail('INVALID_WORKER_PAYLOAD', `${label} is invalid or too long`)
  }
  return normalized
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`
}

export function computeWorkerRequestHash(input) {
  requirePlainObject(input, 'worker request')
  const { requestHash: _ignored, ...hashable } = input
  return crypto.createHash('sha256').update(canonicalStringify(hashable)).digest('hex')
}

export function createWorkerRequest({ jobRef, prompt, negativePrompt, width, height, seed, model = Z_IMAGE_TURBO, steps = Z_IMAGE_TURBO_STEPS } = {}) {
  const request = {
    schemaVersion: WORKER_SCHEMA_VERSION,
    operation: IMAGE_OPERATION,
    jobRef: typeof jobRef === 'string' ? jobRef.toLowerCase() : jobRef,
    model,
    prompt: normalizedText(prompt, 'prompt', { required: true }),
    ...(negativePrompt == null ? {} : { negativePrompt: normalizedText(negativePrompt, 'negativePrompt') }),
    width,
    height,
    seed,
    steps,
  }
  request.requestHash = computeWorkerRequestHash(request)
  return validateWorkerRequest(request)
}

export function validateWorkerRequest(input) {
  requirePlainObject(input, 'worker request')
  rejectUnknownFields(input, REQUEST_FIELDS, 'worker request')
  if (input.schemaVersion !== WORKER_SCHEMA_VERSION) fail('UNSUPPORTED_WORKER_SCHEMA', 'Unsupported worker schema version')
  if (input.operation !== IMAGE_OPERATION) fail('UNSUPPORTED_OPERATION', 'Unsupported media operation')
  if (typeof input.jobRef !== 'string' || !UUID_RE.test(input.jobRef)) fail('INVALID_WORKER_PAYLOAD', 'jobRef must be a UUID')
  if (typeof input.requestHash !== 'string' || !SHA256_RE.test(input.requestHash)) fail('INVALID_WORKER_PAYLOAD', 'requestHash must be a SHA-256 digest')
  if (input.model !== Z_IMAGE_TURBO) fail('MODEL_UNAVAILABLE', 'Unsupported image model')
  const prompt = normalizedText(input.prompt, 'prompt', { required: true })
  const negativePrompt = normalizedText(input.negativePrompt, 'negativePrompt')
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || !DIMENSION_KEYS.has(`${input.width}x${input.height}`)) {
    fail('INVALID_WORKER_PAYLOAD', 'Unsupported image dimensions')
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) fail('INVALID_WORKER_PAYLOAD', 'seed must be an unsigned 32-bit integer')
  if (!Number.isSafeInteger(input.steps) || input.steps < 1 || input.steps > Z_IMAGE_TURBO_MAX_STEPS) {
    fail('INVALID_WORKER_PAYLOAD', `steps must be between 1 and ${Z_IMAGE_TURBO_MAX_STEPS}`)
  }
  const normalized = {
    schemaVersion: input.schemaVersion,
    operation: input.operation,
    jobRef: input.jobRef.toLowerCase(),
    requestHash: input.requestHash,
    model: input.model,
    prompt,
    ...(negativePrompt === undefined ? {} : { negativePrompt }),
    width: input.width,
    height: input.height,
    seed: input.seed,
    steps: input.steps,
  }
  if (computeWorkerRequestHash(normalized) !== normalized.requestHash) fail('REQUEST_HASH_MISMATCH', 'Worker request hash does not match its payload')
  return Object.freeze(normalized)
}

function requireNonNegativeNumber(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('RESULT_INVALID', `${label} must be a non-negative number`)
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function validatePngScanlines(decoded, { width, height, bitDepth, colorType, interlace }) {
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]])
  const allowedDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]])
  if (!allowedDepths.get(colorType)?.includes(bitDepth)) fail('RESULT_INVALID', 'Inline PNG pixel format is invalid')
  const bitsPerPixel = channels.get(colorType) * bitDepth
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
  let offset = 0
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX)
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY)
    if (!passWidth || !passHeight) continue
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8)
    for (let row = 0; row < passHeight; row += 1) {
      if (offset >= decoded.length || decoded[offset] > 4) fail('RESULT_INVALID', 'Inline PNG scanline filter is invalid')
      offset += rowBytes + 1
      if (offset > decoded.length) fail('RESULT_INVALID', 'Inline PNG scanline data is truncated')
    }
  }
  if (offset !== decoded.length) fail('RESULT_INVALID', 'Inline PNG scanline length is invalid')
}

function parsePngDimensions(buffer) {
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('RESULT_INVALID', 'Inline result is not a PNG image')
  }
  let offset = 8
  let width
  let height
  let sawHeader = false
  let sawImageData = false
  let sawEnd = false
  let sawPalette = false
  let paletteEntries = 0
  let imageDataEnded = false
  let bitDepth
  let colorType
  let interlace
  const compressed = []
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail('RESULT_INVALID', 'Inline PNG is truncated')
    const length = buffer.readUInt32BE(offset)
    const typeStart = offset + 4
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (chunkEnd > buffer.length) fail('RESULT_INVALID', 'Inline PNG is truncated')
    const type = buffer.toString('ascii', typeStart, dataStart)
    const expectedCrc = buffer.readUInt32BE(dataEnd)
    if (crc32(buffer.subarray(typeStart, dataEnd)) !== expectedCrc) fail('RESULT_INVALID', 'Inline PNG chunk checksum is invalid')
    if (!sawHeader && type !== 'IHDR') fail('RESULT_INVALID', 'Inline PNG header is missing')
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) fail('RESULT_INVALID', 'Inline PNG header is invalid')
      sawHeader = true
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      bitDepth = buffer[dataStart + 8]
      colorType = buffer[dataStart + 9]
      interlace = buffer[dataStart + 12]
      if (buffer[dataStart + 10] !== 0 || buffer[dataStart + 11] !== 0 || ![0, 1].includes(buffer[dataStart + 12])) fail('RESULT_INVALID', 'Inline PNG encoding is invalid')
    } else if (type === 'PLTE') {
      if (sawImageData || sawPalette || length < 3 || length > 768 || length % 3 !== 0) fail('RESULT_INVALID', 'Inline PNG palette is invalid')
      sawPalette = true
      paletteEntries = length / 3
    } else if (type === 'IDAT') {
      if (!sawHeader || sawEnd || imageDataEnded) fail('RESULT_INVALID', 'Inline PNG image data is misplaced')
      sawImageData = true
      compressed.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      if (!sawImageData || sawEnd || length !== 0 || chunkEnd !== buffer.length) fail('RESULT_INVALID', 'Inline PNG end marker is invalid')
      sawEnd = true
    } else {
      if (sawImageData) imageDataEnded = true
      if (type[0] === type[0]?.toUpperCase()) fail('RESULT_INVALID', 'Inline PNG contains an unsupported critical chunk')
    }
    offset = chunkEnd
  }
  if (!sawHeader || !sawImageData || !sawEnd) fail('RESULT_INVALID', 'Inline PNG is incomplete')
  if (colorType === 3 && !sawPalette) fail('RESULT_INVALID', 'Inline PNG palette is missing')
  if ([0, 4].includes(colorType) && sawPalette) fail('RESULT_INVALID', 'Inline PNG palette is forbidden for its pixel format')
  if (colorType === 3 && paletteEntries > 2 ** bitDepth) fail('RESULT_INVALID', 'Inline PNG palette exceeds its pixel format')
  let decoded
  try {
    const compressedBytes = Buffer.concat(compressed)
    const inflated = zlib.inflateSync(compressedBytes, { maxOutputLength: 64 * 1024 * 1024, info: true })
    if (inflated.engine.bytesWritten !== compressedBytes.length) fail('RESULT_INVALID', 'Inline PNG contains trailing compressed data')
    decoded = inflated.buffer
    if (!decoded.length) fail('RESULT_INVALID', 'Inline PNG image data is empty')
  } catch (error) {
    if (error instanceof WorkerContractError) throw error
    fail('RESULT_INVALID', 'Inline PNG image data is invalid')
  }
  validatePngScanlines(decoded, { width, height, bitDepth, colorType, interlace })
  return { width, height }
}

function validateCommonOutput(output, allowedFields) {
  requirePlainObject(output, 'handler output asset')
  rejectUnknownFields(output, allowedFields, 'handler output asset')
  if (output.mimeType !== 'image/png') fail('RESULT_INVALID', 'Only image/png output is supported')
  if (!Number.isInteger(output.width) || !Number.isInteger(output.height) || !DIMENSION_KEYS.has(`${output.width}x${output.height}`)) fail('RESULT_INVALID', 'Result dimensions are invalid')
  if (!Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 1 || output.sizeBytes > MAX_INLINE_IMAGE_BYTES) fail('RESULT_INVALID', 'Result size is invalid')
  if (typeof output.sha256 !== 'string' || !SHA256_RE.test(output.sha256)) fail('RESULT_INVALID', 'Result checksum is invalid')
}

function validateOutput(output) {
  if (output?.transport === 'inline_base64') {
    validateCommonOutput(output, INLINE_OUTPUT_FIELDS)
    if (typeof output.dataBase64 !== 'string' || !output.dataBase64.length || !BASE64_RE.test(output.dataBase64)) fail('RESULT_INVALID', 'Inline result is not valid base64')
    const bytes = Buffer.from(output.dataBase64, 'base64')
    if (bytes.length !== output.sizeBytes || bytes.length > MAX_INLINE_IMAGE_BYTES) fail('RESULT_INVALID', 'Inline result byte length is invalid')
    const dimensions = parsePngDimensions(bytes)
    if (dimensions.width !== output.width || dimensions.height !== output.height) fail('RESULT_INVALID', 'Inline result dimensions do not match the PNG')
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    if (digest !== output.sha256) fail('RESULT_INVALID', 'Inline result checksum mismatch')
    return Object.freeze({ ...output })
  }
  if (output?.transport === 'object_ref') {
    validateCommonOutput(output, OBJECT_OUTPUT_FIELDS)
    if (typeof output.objectRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(output.objectRef) || output.objectRef.includes('..') || output.objectRef.includes('://') || output.objectRef.startsWith('/')) {
      fail('RESULT_INVALID', 'Object reference is invalid')
    }
    return Object.freeze({ ...output })
  }
  fail('RESULT_INVALID', 'Unsupported result transport')
}

export function validateHandlerOutput(payload, { expectedRequest } = {}) {
  requirePlainObject(payload, 'handler output')
  rejectUnknownFields(payload, HANDLER_FIELDS, 'handler output')
  if (payload.schemaVersion !== WORKER_SCHEMA_VERSION) fail('RESULT_INVALID', 'Result schema version mismatch')
  if (typeof payload.jobRef !== 'string' || !UUID_RE.test(payload.jobRef)) fail('RESULT_INVALID', 'Result jobRef is invalid')
  if (typeof payload.requestHash !== 'string' || !SHA256_RE.test(payload.requestHash)) fail('RESULT_INVALID', 'Result requestHash is invalid')

  requirePlainObject(payload.provenance, 'result provenance')
  rejectUnknownFields(payload.provenance, PROVENANCE_FIELDS, 'result provenance')
  if (payload.provenance.model !== Z_IMAGE_TURBO || typeof payload.provenance.modelRevision !== 'string' || !payload.provenance.modelRevision || typeof payload.provenance.runtime !== 'string' || !payload.provenance.runtime) fail('RESULT_INVALID', 'Result provenance is invalid')
  if (!Number.isSafeInteger(payload.provenance.seed) || payload.provenance.seed < 0 || payload.provenance.seed > 0xffffffff || !Number.isSafeInteger(payload.provenance.steps) || payload.provenance.steps < 1 || payload.provenance.steps > Z_IMAGE_TURBO_MAX_STEPS) fail('RESULT_INVALID', 'Result generation parameters are invalid')

  requirePlainObject(payload.timings, 'result timings')
  rejectUnknownFields(payload.timings, TIMING_FIELDS, 'result timings')
  requireNonNegativeNumber(payload.timings.queueMs, 'queueMs', { nullable: true })
  requireNonNegativeNumber(payload.timings.loadMs, 'loadMs', { nullable: true })
  requireNonNegativeNumber(payload.timings.inferenceMs, 'inferenceMs', { nullable: true })
  requireNonNegativeNumber(payload.timings.handlerTotalMs, 'handlerTotalMs', { nullable: true })
  requireNonNegativeNumber(payload.timings.gpuActiveSeconds, 'gpuActiveSeconds', { nullable: true })
  requirePlainObject(payload.timings.sources, 'timing sources')
  rejectUnknownFields(payload.timings.sources, SOURCE_FIELDS, 'timing sources')
  for (const key of SOURCE_FIELDS) {
    if (!['provider', 'worker_observed', 'unavailable'].includes(payload.timings.sources[key])) fail('RESULT_INVALID', 'Timing source is invalid')
  }

  const output = validateOutput(payload.output)
  if (expectedRequest) {
    const request = validateWorkerRequest(expectedRequest)
    if (payload.jobRef.toLowerCase() !== request.jobRef || payload.requestHash !== request.requestHash || payload.provenance.model !== request.model || payload.provenance.seed !== request.seed || payload.provenance.steps !== request.steps || output.width !== request.width || output.height !== request.height) {
      fail('RESULT_INVALID', 'Result provenance does not match the submitted request')
    }
  }
  return Object.freeze({ ...payload, output, provenance: Object.freeze({ ...payload.provenance }), timings: Object.freeze({ ...payload.timings, sources: Object.freeze({ ...payload.timings.sources }) }) })
}
