export const AI_JOB_KINDS = Object.freeze({
  TONY: 'tony', VIDEO: 'video', PHOTOSHOOT: 'photoshoot', TRANSLATE_IMAGE: 'translate_image', SEO: 'seo',
})

const POLICIES = Object.freeze({
  tony: { timeoutMs: 45_000, maxRetries: 1 },
  video: { timeoutMs: 120_000, maxRetries: 2 },
  photoshoot: { timeoutMs: 120_000, maxRetries: 2 },
  translate_image: { timeoutMs: 90_000, maxRetries: 1 },
  seo: { timeoutMs: 90_000, maxRetries: 2 },
})

export function getJobPolicy(kind) {
  const policy = POLICIES[kind]
  if (!policy) throw new TypeError(`Unsupported AI job kind: ${kind}`)
  return policy
}

export function legacyStatus(status) {
  return ({ queued: 'pending', running: 'processing', succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' })[status]
}

export function normalizeArtifacts(kind, result = {}) {
  const artifacts = []
  const add = (type, url, data) => { if (url || data != null) artifacts.push({ type, ...(url ? { url } : {}), ...(data != null ? { data } : {}) }) }
  if (kind === AI_JOB_KINDS.VIDEO) add('video', result.videoUrl)
  if (kind === AI_JOB_KINDS.PHOTOSHOOT) add('image', result.imageUrl)
  if (kind === AI_JOB_KINDS.TRANSLATE_IMAGE) {
    add('translated_image', result.translatedImageUrl)
    add('translation', null, { detectedText: result.detectedText, translatedText: result.translatedText })
  }
  if (kind === AI_JOB_KINDS.TONY) add('message', null, { reply: result.reply })
  if (kind === AI_JOB_KINDS.SEO) add('seo_report', null, result.report || result)
  return artifacts
}
