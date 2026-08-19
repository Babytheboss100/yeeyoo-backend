import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { assertStorageAdapter } from '../storage/contract.js'
import { prepareComposerProject } from '../composer/project.js'

const MIME_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
})
const SHA256_RE = /^[a-f0-9]{64}$/

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} is invalid`)
  return value
}

function safeAssetName(index, mimeType) {
  const extension = MIME_EXTENSIONS[mimeType]
  if (!extension) throw new TypeError('asset mimeType is unsupported')
  return `asset-${index}.${extension}`
}

function uniqueAssetIds(project, collectAssetRefs) {
  const refs = collectAssetRefs(project)
  if (!Array.isArray(refs)) throw new TypeError('collectAssetRefs returned invalid data')
  const ids = []
  const seen = new Set()
  for (const item of refs) {
    const assetId = item?.ref?.assetId
    if (typeof assetId !== 'string' || !assetId || seen.has(assetId)) continue
    seen.add(assetId)
    ids.push(assetId)
  }
  return ids
}

async function materializeAssets({ project, assetBindings, collectAssetRefs, storage, workDir }) {
  requirePlainObject(assetBindings, 'assetBindings')
  const assetMap = Object.create(null)
  const assetIds = uniqueAssetIds(project, collectAssetRefs)
  for (const [index, assetId] of assetIds.entries()) {
    const binding = assetBindings[assetId]
    requirePlainObject(binding, `assetBindings.${assetId}`)
    if (typeof binding.objectRef !== 'string' || typeof binding.mimeType !== 'string' || !SHA256_RE.test(binding.sha256 || '')) throw new TypeError(`asset binding is invalid: ${assetId}`)
    const metadata = await storage.stat(binding.objectRef)
    if (metadata.sha256 !== binding.sha256 || metadata.mimeType !== binding.mimeType) throw Object.assign(new Error('Stored source asset metadata changed'), { code: 'SOURCE_ASSET_INTEGRITY_FAILED' })
    const bytes = Buffer.from(await storage.get(binding.objectRef))
    if (digest(bytes) !== binding.sha256 || bytes.length !== metadata.sizeBytes) throw Object.assign(new Error('Stored source asset checksum changed'), { code: 'SOURCE_ASSET_INTEGRITY_FAILED' })
    const target = path.join(workDir, safeAssetName(index, binding.mimeType))
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
    assetMap[assetId] = target
  }
  return assetMap
}

export async function executeVideoRender({
  project,
  genomeHints = {},
  assetBindings = {},
  storage,
  composeVideo,
  validateProject,
  deriveGenome,
  collectAssetRefs,
  signal,
  onProgress,
  workspaceRoot = path.join(os.tmpdir(), 'yeeyoo-media-render'),
} = {}) {
  assertStorageAdapter(storage)
  if (typeof composeVideo !== 'function' || typeof collectAssetRefs !== 'function') throw new TypeError('Composer API is invalid')
  const prepared = prepareComposerProject({ project, hints: genomeHints, validateProject, deriveGenome })
  if (!path.isAbsolute(workspaceRoot) || workspaceRoot === path.parse(workspaceRoot).root) throw new TypeError('workspaceRoot must be a narrow absolute path')
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
  const workDir = await mkdtemp(path.join(workspaceRoot, 'job-'))
  const outPath = path.join(workDir, 'render.mp4')
  try {
    const assetMap = await materializeAssets({ project: prepared.project, assetBindings, collectAssetRefs, storage, workDir })
    const render = await composeVideo(prepared.project, { outPath, assetMap, signal, onProgress })
    const bytes = await readFile(outPath)
    const sha256 = digest(bytes)
    if (render?.outPath !== outPath || render?.sha256 !== sha256 || render?.sizeBytes !== bytes.length) {
      throw Object.assign(new Error('Composer output verification did not match stored bytes'), { code: 'COMPOSER_OUTPUT_INTEGRITY_FAILED' })
    }
    const stored = await storage.put({ bytes, mimeType: 'video/mp4', expectedSha256: sha256 })
    if (stored.sha256 !== sha256 || stored.sizeBytes !== bytes.length) throw Object.assign(new Error('Stored render verification failed'), { code: 'RENDER_STORAGE_INTEGRITY_FAILED' })
    return Object.freeze({
      stored,
      genome: prepared.genome,
      composerProjectSha256: prepared.projectSha256,
      render: Object.freeze({
        sha256,
        sizeBytes: bytes.length,
        durationSeconds: render.durationSeconds,
        width: render.width,
        height: render.height,
        fps: render.fps,
      }),
      artifactContent: Object.freeze({
        media: Object.freeze({
          kind: 'video',
          objectRef: stored.objectRef,
          mimeType: stored.mimeType,
          sha256,
          sizeBytes: bytes.length,
          composerProjectSha256: prepared.projectSha256,
        }),
      }),
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

