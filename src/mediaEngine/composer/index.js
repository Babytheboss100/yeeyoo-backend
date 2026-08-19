export {
  COMPOSER_API_VERSION,
  COMPOSER_BUILD,
  COMPOSER_SOURCE,
  ComposerProjectError,
  composerProjectSha256,
  prepareComposerProject,
} from './project.js'
export { assertRenderApproval, createRenderApprovalBinding, revokeRenderApproval } from './approvalBinding.js'

// Import `./runtime.js` only in the render worker. It loads the native canvas
// dependency and FFmpeg-backed composer; API/route processes can use the pure
// contracts above without initializing the renderer.
