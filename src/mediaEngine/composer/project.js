import crypto from 'node:crypto'
import { canonicalStringify } from '../contracts/workerApi.js'
import { normalizeArtifactGenome } from '../genome/bridge.js'

export const COMPOSER_SOURCE = 'yeeyoo-media-composer'
export const COMPOSER_API_VERSION = '0.3'
export const COMPOSER_BUILD = Object.freeze({
  sourceArchiveVersion: 'v0.3.1',
  packageVersion: '0.3.0',
  upstreamArchiveSha256: '647be6f4cd385c0197ba896d9cdc62938486ce2df984d2b406392e5ed1792428',
  integrationHardening: 'cancel-and-resource-bounds-v1',
})

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`)
  return value
}

function safeValidationErrors(errors) {
  if (!Array.isArray(errors)) return []
  return errors.slice(0, 8).map(error => Object.freeze({
    code: typeof error?.code === 'string' ? error.code : 'COMPOSER_PROJECT_INVALID',
    path: typeof error?.path === 'string' ? error.path : '',
  }))
}

export class ComposerProjectError extends Error {
  constructor(code, message, { details = [] } = {}) {
    super(message)
    this.name = 'ComposerProjectError'
    this.code = code
    this.details = Object.freeze(details)
  }
}

export function composerProjectSha256(project) {
  return crypto.createHash('sha256').update(canonicalStringify(project)).digest('hex')
}

export function prepareComposerProject({ project, hints = {}, validateProject, deriveGenome } = {}) {
  requireFunction(validateProject, 'validateProject')
  requireFunction(deriveGenome, 'deriveGenome')
  const validation = validateProject(project)
  if (!validation || validation.ok !== true || !validation.project) {
    throw new ComposerProjectError('COMPOSER_PROJECT_INVALID', 'Composer project is invalid', {
      details: safeValidationErrors(validation?.errors),
    })
  }
  const normalizedProject = validation.project
  const projectSha256 = composerProjectSha256(normalizedProject)
  const genome = normalizeArtifactGenome(deriveGenome(normalizedProject, {
    ...hints,
    source: COMPOSER_SOURCE,
    composerProjectSha256: projectSha256,
  }))
  if (genome.derivation_failed === true) {
    throw new ComposerProjectError('COMPOSER_GENOME_DERIVATION_FAILED', 'Composer genome derivation failed')
  }
  return Object.freeze({
    project: structuredClone(normalizedProject),
    projectSha256,
    genome,
    composer: Object.freeze({ source: COMPOSER_SOURCE, apiVersion: COMPOSER_API_VERSION, ...COMPOSER_BUILD }),
  })
}
