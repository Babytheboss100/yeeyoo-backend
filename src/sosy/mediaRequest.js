const HINT_FIELDS = new Set(['narrative', 'hookType', 'ctaType', 'audience', 'language'])

function fail(code, message) { throw Object.assign(new TypeError(message), { code, status: 400 }) }
function text(value, name, max = 2000, { optional = false } = {}) {
  if (optional && value == null) return null
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_MEDIA_REQUEST', `${name} is invalid`)
  return value
}
function hints(value, fallbackLanguage) {
  if (value == null) value = {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !HINT_FIELDS.has(key))) fail('INVALID_MEDIA_REQUEST', 'genomeHints are invalid')
  const normalized = {}
  for (const field of HINT_FIELDS) if (value[field] != null) normalized[field] = text(value[field], `genomeHints.${field}`, 500)
  if (!normalized.language && fallbackLanguage) normalized.language = fallbackLanguage
  if (normalized.audience) normalized.audienceSegment = normalized.audience
  return Object.freeze(normalized)
}
export function normalizeSosyMediaRequest(value, { objective, outputLanguage } = {}) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_MEDIA_REQUEST', 'mediaRequest must be an object')
  const allowed = new Set(['operation', 'prompt', 'negativePrompt', 'width', 'height', 'seed', 'steps', 'composerProject', 'genomeHints'])
  if (Object.keys(value).some(key => !allowed.has(key))) fail('INVALID_MEDIA_REQUEST', 'mediaRequest contains unsupported fields')
  const operation = value.operation
  if (!['image.generate', 'video.render'].includes(operation)) fail('INVALID_MEDIA_REQUEST', 'mediaRequest.operation is unsupported')
  const genomeHints = hints(value.genomeHints, outputLanguage)
  if (operation === 'video.render') {
    if (!value.composerProject || typeof value.composerProject !== 'object' || Array.isArray(value.composerProject)) fail('INVALID_MEDIA_REQUEST', 'video.render requires composerProject')
    if (value.prompt != null || value.negativePrompt != null || value.width != null || value.height != null || value.seed != null || value.steps != null) fail('INVALID_MEDIA_REQUEST', 'video.render contains image-only fields')
    return Object.freeze({ operation, composerProject: structuredClone(value.composerProject), genomeHints })
  }
  if (value.composerProject != null) fail('INVALID_MEDIA_REQUEST', 'image.generate cannot contain composerProject')
  const request = { operation, prompt: text(value.prompt ?? objective, 'mediaRequest.prompt', 4000), genomeHints }
  if (value.negativePrompt != null) request.negativePrompt = text(value.negativePrompt, 'mediaRequest.negativePrompt', 2000)
  for (const field of ['width', 'height', 'seed', 'steps']) if (value[field] != null) request[field] = value[field]
  return Object.freeze(request)
}
