import crypto from 'node:crypto'
import path from 'node:path'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { assertStorageAdapter, StorageAdapterError } from './contract.js'

const MIME_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
})
const OBJECT_REF_RE = /^media\/([a-f0-9]{64})\.(png|jpg|webp|mp4|mp3|wav|ttf|otf)$/
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const ROOT_WRITE_TAILS = new Map()

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function validateRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath === path.parse(rootPath).root) {
    throw new TypeError('Local media storage requires a narrow absolute rootPath')
  }
  return path.resolve(rootPath)
}

function validateObjectRef(objectRef) {
  if (typeof objectRef !== 'string' || !OBJECT_REF_RE.test(objectRef)) {
    throw new StorageAdapterError('INVALID_OBJECT_REF', 'Stored media reference is invalid', { status: 400 })
  }
  return objectRef
}

function publicMetadata({ objectRef, mimeType, sizeBytes, sha256 }) {
  return Object.freeze({ storage: 'local-disk-fake', objectRef, mimeType, sizeBytes, sha256, persistent: false })
}

function mapIoError(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return new StorageAdapterError('OBJECT_NOT_FOUND', 'Stored media asset was not found', { status: 404 })
  return new StorageAdapterError('STORAGE_IO_ERROR', 'Local media storage operation failed', { status: 500 })
}

async function maybeLstat(target) {
  try { return await lstat(target) } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw mapIoError(error)
  }
}

export function createLocalDiskStorageAdapter({ rootPath, maxBytes = DEFAULT_MAX_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
  const root = validateRoot(rootPath)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024) throw new TypeError('Local media storage maxBytes is invalid')
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxBytes || maxTotalBytes > 8 * 1024 * 1024 * 1024) throw new TypeError('Local media storage maxTotalBytes is invalid')
  async function withWriteLock(action) {
    const previous = ROOT_WRITE_TAILS.get(root) || Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    ROOT_WRITE_TAILS.set(root, tail)
    await previous
    try { return await action() } finally {
      release()
      if (ROOT_WRITE_TAILS.get(root) === tail) ROOT_WRITE_TAILS.delete(root)
    }
  }

  async function mediaDirectory() {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const rootInfo = await lstat(root)
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new StorageAdapterError('UNSAFE_STORAGE_ROOT', 'Local media storage root is unsafe', { status: 500 })
      const canonicalRoot = await realpath(root)
      const configuredMedia = path.join(root, 'media')
      let mediaInfo = await maybeLstat(configuredMedia)
      if (mediaInfo?.isSymbolicLink() || (mediaInfo && !mediaInfo.isDirectory())) throw new StorageAdapterError('UNSAFE_STORAGE_ROOT', 'Local media storage directory is unsafe', { status: 500 })
      if (!mediaInfo) await mkdir(configuredMedia, { mode: 0o700 })
      mediaInfo = await lstat(configuredMedia)
      if (mediaInfo.isSymbolicLink() || !mediaInfo.isDirectory()) throw new StorageAdapterError('UNSAFE_STORAGE_ROOT', 'Local media storage directory is unsafe', { status: 500 })
      const canonicalMedia = await realpath(configuredMedia)
      if (canonicalMedia !== path.join(canonicalRoot, 'media')) throw new StorageAdapterError('UNSAFE_STORAGE_ROOT', 'Local media storage directory escapes its root', { status: 500 })
      return canonicalMedia
    } catch (error) {
      if (error instanceof StorageAdapterError) throw error
      throw mapIoError(error)
    }
  }

  function resolveRef(objectRef, directory) {
    const valid = validateObjectRef(objectRef)
    const filename = valid.slice('media/'.length)
    const target = path.join(directory, filename)
    if (path.dirname(target) !== directory) throw new StorageAdapterError('INVALID_OBJECT_REF', 'Stored media reference escapes its storage root', { status: 400 })
    return { objectRef: valid, target }
  }

  async function verifiedBytes(objectRef) {
    const directory = await mediaDirectory()
    const { target } = resolveRef(objectRef, directory)
    const file = await maybeLstat(target)
    if (!file) throw new StorageAdapterError('OBJECT_NOT_FOUND', 'Stored media asset was not found', { status: 404 })
    if (file.isSymbolicLink() || !file.isFile()) throw new StorageAdapterError('STORED_ASSET_INVALID', 'Stored media asset type is invalid')
    let bytes
    try { bytes = await readFile(target) } catch (error) { throw mapIoError(error) }
    if (bytes.length < 1 || bytes.length > maxBytes) throw new StorageAdapterError('STORED_ASSET_INVALID', 'Stored media asset exceeds its size limit')
    const match = OBJECT_REF_RE.exec(objectRef)
    if (!match || digest(bytes) !== match[1]) throw new StorageAdapterError('STORED_ASSET_INVALID', 'Stored media asset checksum is invalid')
    return bytes
  }

  async function usedBytes(directory) {
    let total = 0
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { throw mapIoError(error) }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new StorageAdapterError('STORED_ASSET_INVALID', 'Local media storage contains an unsafe entry')
      const file = await maybeLstat(path.join(directory, entry.name))
      if (!file || file.isSymbolicLink() || !file.isFile()) throw new StorageAdapterError('STORED_ASSET_INVALID', 'Local media storage contains an unsafe entry')
      total += file.size
      if (total > maxTotalBytes) throw new StorageAdapterError('STORAGE_CAPACITY_EXCEEDED', 'Local media storage capacity is exhausted', { status: 507 })
    }
    return total
  }

  const adapter = {
    name: 'local-disk-fake',
    capabilities() {
      return { persistent: false, transports: ['inline_base64'], maxBytes, maxTotalBytes, mimeTypes: Object.keys(MIME_EXTENSIONS) }
    },

    async put({ bytes, mimeType, expectedSha256 } = {}) {
      const data = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes) : null
      const extension = MIME_EXTENSIONS[mimeType]
      if (!data || data.length < 1 || data.length > maxBytes) throw new StorageAdapterError('INVALID_ASSET', 'Media asset size is invalid', { status: 400 })
      if (!extension) throw new StorageAdapterError('UNSUPPORTED_MEDIA_TYPE', 'Media asset type is not supported', { status: 400 })
      const sha256 = digest(data)
      if (expectedSha256 && expectedSha256 !== sha256) throw new StorageAdapterError('ASSET_CHECKSUM_MISMATCH', 'Media asset checksum mismatch', { status: 400 })
      const objectRef = `media/${sha256}.${extension}`
      return withWriteLock(async () => {
        const directory = await mediaDirectory()
        const { target } = resolveRef(objectRef, directory)
        const existing = await maybeLstat(target)
        if (existing) {
          const stored = await verifiedBytes(objectRef)
          if (!stored.equals(data)) throw new StorageAdapterError('STORED_ASSET_INVALID', 'Stored media asset content is invalid')
          return publicMetadata({ objectRef, mimeType, sizeBytes: data.length, sha256 })
        }
        if (await usedBytes(directory) + data.length > maxTotalBytes) throw new StorageAdapterError('STORAGE_CAPACITY_EXCEEDED', 'Local media storage capacity is exhausted', { status: 507 })
        const temporary = path.join(directory, `.${sha256}.${crypto.randomUUID()}.tmp`)
        let handle
        try {
          handle = await open(temporary, 'wx', 0o600)
          await handle.writeFile(data)
          await handle.sync()
          await handle.close()
          handle = null
          await rename(temporary, target)
        } catch (error) {
          if (error instanceof StorageAdapterError) throw error
          throw mapIoError(error)
        } finally {
          if (handle) await handle.close().catch(() => {})
          await unlink(temporary).catch(() => {})
        }
        return publicMetadata({ objectRef, mimeType, sizeBytes: data.length, sha256 })
      })
    },

    async get(objectRef) {
      return verifiedBytes(validateObjectRef(objectRef))
    },

    async stat(objectRef) {
      const valid = validateObjectRef(objectRef)
      const bytes = await verifiedBytes(valid)
      const match = OBJECT_REF_RE.exec(valid)
      const extension = match?.[2]
      const mimeType = Object.entries(MIME_EXTENSIONS).find(([, value]) => value === extension)?.[0]
      return publicMetadata({ objectRef: valid, mimeType, sizeBytes: bytes.length, sha256: match[1] })
    },
  }
  return Object.freeze(assertStorageAdapter(adapter))
}
