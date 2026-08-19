export class MediaJobError extends Error {
  constructor(code, message, { status = 400, retryable = false } = {}) {
    super(message)
    this.name = 'MediaJobError'
    this.code = code
    this.status = status
    this.retryable = Boolean(retryable)
  }
}

export function mediaJobError(code, message, options) {
  return new MediaJobError(code, message, options)
}

export function toSafeMediaJobError(error) {
  if (error instanceof MediaJobError) return error
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'INVALID_WORKER_PAYLOAD' || code === 'UNSUPPORTED_WORKER_SCHEMA' || code === 'UNSUPPORTED_OPERATION' || code === 'MODEL_UNAVAILABLE' || code === 'REQUEST_HASH_MISMATCH') {
    return new MediaJobError('INVALID_MEDIA_JOB_REQUEST', 'Media job input is invalid', { status: 400 })
  }
  return new MediaJobError('MEDIA_JOB_OPERATION_FAILED', 'Media job operation failed', { status: 500 })
}
