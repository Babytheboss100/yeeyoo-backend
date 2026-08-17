const MILLION = 1_000_000

export const DEFAULT_AI_PRICING = Object.freeze({
  version: 'non-commercial-test-v1',
  models: Object.freeze({
    'anthropic/claude-sonnet-4-20250514': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
    'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
    'google/gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5, cachedInputPerMillion: 0.075 },
    'xai/grok-2-1212': { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 2 },
    'deepseek/deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1, cachedInputPerMillion: 0.07 },
    'local/deterministic-fixture-v1': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
  }),
})

function finiteNonNegative(value, name) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} must be a non-negative number`)
  return number
}

export function loadPricingTable(env = process.env) {
  if (!env.AI_MODEL_PRICING_JSON) {
    if (env.NODE_ENV === 'test' || env.AI_USE_TEST_PRICING === 'true') return DEFAULT_AI_PRICING
    throw Object.assign(new Error('AI model pricing is not configured'), { code: 'AI_PRICING_NOT_CONFIGURED' })
  }
  let parsed
  try { parsed = JSON.parse(env.AI_MODEL_PRICING_JSON) } catch { throw new Error('AI_MODEL_PRICING_JSON must be valid JSON') }
  if (!parsed?.version || !parsed.models || typeof parsed.models !== 'object') throw new Error('AI_MODEL_PRICING_JSON requires version and models')
  for (const [key, rate] of Object.entries(parsed.models)) {
    if (!key.includes('/')) throw new Error(`Invalid AI pricing key: ${key}`)
    finiteNonNegative(rate.inputPerMillion, 'inputPerMillion')
    finiteNonNegative(rate.outputPerMillion, 'outputPerMillion')
    finiteNonNegative(rate.cachedInputPerMillion, 'cachedInputPerMillion')
    if (rate.perAudioSecond != null) finiteNonNegative(rate.perAudioSecond, 'perAudioSecond')
    if (rate.perMillionCharacters != null) finiteNonNegative(rate.perMillionCharacters, 'perMillionCharacters')
  }
  return parsed
}

export function lookupModelPrice({ provider, model, table = loadPricingTable() }) {
  const key = `${String(provider || '').toLowerCase()}/${String(model || '').toLowerCase()}`
  const rate = table.models[key]
  if (!rate) throw Object.assign(new Error(`No cost configuration for ${key}`), { code: 'AI_PRICE_UNKNOWN' })
  return { key, version: table.version, ...rate }
}

// Media-priced work (speech in, speech out) is billed per audio second or per
// character rather than per token; token rates stay authoritative for text.
function mediaCost(price, mediaUnits, mediaUnitType) {
  if (!mediaUnits) return 0
  if (mediaUnitType === 'audio_seconds') return mediaUnits * Number(price.perAudioSecond ?? 0)
  if (mediaUnitType === 'characters') return (mediaUnits * Number(price.perMillionCharacters ?? 0)) / MILLION
  return 0
}

export function calculateModelCost({ provider, model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, mediaUnits = 0, mediaUnitType = null, table }) {
  const input = finiteNonNegative(inputTokens, 'inputTokens')
  const output = finiteNonNegative(outputTokens, 'outputTokens')
  const cached = finiteNonNegative(cachedInputTokens, 'cachedInputTokens')
  if (![input, output, cached].every(Number.isInteger)) throw new TypeError('Token counts must be integers')
  const media = finiteNonNegative(mediaUnits, 'mediaUnits')
  const price = lookupModelPrice({ provider, model, table })
  const tokenCost = ((input * price.inputPerMillion) + (output * price.outputPerMillion) + (cached * price.cachedInputPerMillion)) / MILLION
  const costUsd = tokenCost + mediaCost(price, media, mediaUnitType)
  return { costUsd: Number(costUsd.toFixed(8)), pricingVersion: price.version, priceKey: price.key }
}
