import { collectAssetRefs } from './vendor/v0.3.1/assets.js'
import { composeVideo } from './vendor/v0.3.1/compose.js'
import { deriveGenome } from './vendor/v0.3.1/genome.js'
import { validateProject } from './vendor/v0.3.1/schema.js'
import { executeVideoRender } from '../executors/videoRender.js'
import { prepareComposerProject } from './project.js'

const composerApi = Object.freeze({ collectAssetRefs, composeVideo, deriveGenome, validateProject })

export function prepareVendoredComposerProject(input = {}) {
  return prepareComposerProject({ ...input, validateProject, deriveGenome })
}

export function executeComposerVideoRender(input = {}) {
  return executeVideoRender({ ...input, ...composerApi })
}

export { collectAssetRefs, composeVideo, deriveGenome, validateProject }

