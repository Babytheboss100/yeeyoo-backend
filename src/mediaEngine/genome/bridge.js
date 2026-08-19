const MAX_GENOME_BYTES = 256 * 1024
const MAX_GENOME_DEPTH = 64
const MAX_GENOME_NODES = 10_000
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
import { deriveGenome as vendoredDeriveGenome } from '../composer/vendor/v0.3.1/genome.js'

function assertJsonValue(value) {
  const ancestors = new Set()
  const stack = [{ value, path: 'genome', depth: 0, exit: false }]
  let nodes = 0
  let observedBytes = 2
  while (stack.length) {
    const current = stack.pop()
    if (current.exit) {
      ancestors.delete(current.value)
      continue
    }
    nodes += 1
    if (nodes > MAX_GENOME_NODES) throw new TypeError('genome exceeds its node limit')
    if (current.depth > MAX_GENOME_DEPTH) throw new TypeError('genome exceeds its depth limit')
    const item = current.value
    if (item === null || typeof item === 'boolean') {
      observedBytes += 5
      if (observedBytes > MAX_GENOME_BYTES) throw new TypeError('genome exceeds its size limit')
      continue
    }
    if (typeof item === 'string') {
      observedBytes += Buffer.byteLength(item, 'utf8') + 2
      if (observedBytes > MAX_GENOME_BYTES) throw new TypeError('genome exceeds its size limit')
      continue
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError(`${current.path} contains a non-finite number`)
      observedBytes += 32
      if (observedBytes > MAX_GENOME_BYTES) throw new TypeError('genome exceeds its size limit')
      continue
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError(`${current.path} must be acyclic JSON data`)
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError(`${current.path} must contain plain objects`)
    ancestors.add(item)
    stack.push({ ...current, exit: true })
    const descriptors = Array.isArray(item) ? null : Object.getOwnPropertyDescriptors(item)
    if (descriptors && Object.values(descriptors).some(descriptor => typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) throw new TypeError(`${current.path} must not contain accessors`)
    const entries = Array.isArray(item) ? Array.from(item.entries(), ([index, child]) => [String(index), child]) : Object.entries(item)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]
      if (!Array.isArray(item) && FORBIDDEN_KEYS.has(key)) throw new TypeError(`${current.path} contains a forbidden key`)
      if (!Array.isArray(item)) {
        observedBytes += Buffer.byteLength(key, 'utf8') + 3
        if (observedBytes > MAX_GENOME_BYTES) throw new TypeError('genome exceeds its size limit')
      }
      stack.push({ value: child, path: Array.isArray(item) ? `${current.path}[${key}]` : `${current.path}.*`, depth: current.depth + 1, exit: false })
    }
  }
}

export function normalizeArtifactGenome(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('genome must be an object')
  assertJsonValue(value)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > MAX_GENOME_BYTES) throw new TypeError('genome exceeds its size limit')
  return JSON.parse(json)
}

// Composer v0.3.1 owns deriveGenome. This bridge deliberately accepts that
// function as a dependency so the backend does not duplicate or silently
// redesign Claude's derivation contract while the original ZIP is unavailable.
export async function deriveArtifactGenome({ composerProject, genomeHints = {}, deriveGenome = vendoredDeriveGenome } = {}) {
  if (!composerProject || typeof composerProject !== 'object') throw new TypeError('composerProject is required')
  if (typeof deriveGenome !== 'function') throw new TypeError('deriveGenome implementation is required')
  return normalizeArtifactGenome(await deriveGenome(composerProject, genomeHints))
}

export { MAX_GENOME_BYTES, MAX_GENOME_DEPTH, MAX_GENOME_NODES }
