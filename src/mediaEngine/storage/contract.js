export const STORAGE_ADAPTER_CONTRACT_VERSION = 'yeeyoo.media.storage.v1'
export const STORAGE_ADAPTER_SIGNATURE = Object.freeze({
  capabilities: '() -> StorageCapabilities',
  put: '(asset) -> Promise<StoredArtifact>',
  get: '(objectRef) -> Promise<StoredBytes>',
  stat: '(objectRef) -> Promise<StoredArtifact>',
})

export class StorageAdapterError extends Error {
  constructor(code, message, { status = 500 } = {}) {
    super(message)
    this.name = 'StorageAdapterError'
    this.code = code
    this.status = status
  }
}

export function assertStorageAdapter(adapter) {
  if (!adapter || Object.keys(STORAGE_ADAPTER_SIGNATURE).some(method => typeof adapter[method] !== 'function')) {
    throw new TypeError('Storage adapter does not satisfy the Media Engine contract')
  }
  return adapter
}
