import { WorkerContractError } from './workerApi.js'

export const PROVIDER_ADAPTER_CONTRACT_VERSION = 'yeeyoo.media.provider.v1'
export const PROVIDER_ADAPTER_SIGNATURE = Object.freeze({
  capabilities: '() -> Capabilities',
  estimateCost: '(workerRequest?) -> CostEstimate',
  submit: '(workerRequest) -> Promise<{ providerJobId }>',
  getStatus: '(providerJobId, expectedRequest?) -> Promise<ProviderJobStatus>',
  cancel: '(providerJobId) -> Promise<{ providerJobId, state }>',
  normalizeResult: '(handlerOutput, expectedRequest?) -> HandlerOutput',
})
export const PROVIDER_JOB_STATES = Object.freeze(['queued', 'processing', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired'])
export const PROVIDER_ERROR_CODES = Object.freeze([
  'AUTH_ERROR', 'MODEL_UNAVAILABLE', 'CONTENT_REJECTED', 'INVALID_INPUT', 'RATE_LIMITED',
  'PROVIDER_TIMEOUT', 'PROVIDER_TEMPORARY', 'PROVIDER_PERMANENT', 'BILLING_REJECTED',
  'RESULT_INVALID', 'RESULT_EXPIRED', 'IDEMPOTENCY_CONFLICT', 'CANCELLED',
])

const STATUS_MAP = Object.freeze({
  IN_QUEUE: 'queued',
  IN_PROGRESS: 'processing',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  RESULT_EXPIRED: 'expired',
})

export class ProviderAdapterError extends Error {
  constructor(code, message, { retryable = false, providerStatus = null } = {}) {
    super(message)
    this.name = 'ProviderAdapterError'
    this.code = PROVIDER_ERROR_CODES.includes(code) ? code : 'PROVIDER_PERMANENT'
    this.retryable = Boolean(retryable)
    this.providerStatus = providerStatus
  }
}

export function mapProviderStatus(status) {
  const mapped = STATUS_MAP[status]
  if (!mapped) throw new ProviderAdapterError('PROVIDER_TEMPORARY', 'Provider returned an unknown status', { retryable: true })
  return mapped
}

export function normalizeProviderError(error) {
  if (error instanceof ProviderAdapterError) return error
  if (error instanceof WorkerContractError) return new ProviderAdapterError(error.code === 'RESULT_INVALID' ? 'RESULT_INVALID' : 'INVALID_INPUT', error.message, { retryable: false })
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new ProviderAdapterError('PROVIDER_TIMEOUT', 'Image worker timed out', { retryable: true })
  return new ProviderAdapterError('PROVIDER_TEMPORARY', 'Image worker request failed', { retryable: true })
}

export function assertProviderAdapter(adapter) {
  const methods = Object.keys(PROVIDER_ADAPTER_SIGNATURE)
  if (!adapter || methods.some(method => typeof adapter[method] !== 'function')) throw new TypeError('Provider adapter does not satisfy the Media Engine contract')
  return adapter
}
