// yeeyoo-media-composer — offentlig API (v0.2)
// Yeeyoo-eid renderkjerne. Eier IKKE auth, tenant, DB, nettverk, cost ledger,
// Approval eller publisering — det eier Media Engine rundt den.

export { composeVideo } from './compose.js'
export { validateProject, defaultProject, LIMITS } from './schema.js'
export { computeTimeline, activeScenes, elementVisibility, activeCaptions } from './timeline.js'
export { renderFrame } from './renderFrame.js'
export { fittedPlacement } from './geometry.js'
export { resolveAssets, loadImages, registerFont, registerProjectFonts, applyRegisteredFonts, collectAssetRefs } from './assets.js'
export { buildFfmpegArgs, createEncoder } from './encode.js'
export { probeMedia, extractClipFrames, clipFramePath } from './videoFrames.js'
export { verifyOutput, sha256File } from './verify.js'
export { easings, ease, lerp } from './easing.js'
export { deriveGenome } from './genome.js'
