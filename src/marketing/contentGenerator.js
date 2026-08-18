// Real content generation for the canonical marketing layer.
//
// The Sosy/specialist layer shipped with deterministic fixtures so governance
// could be certified without provider calls. This module is the bridge to a
// real model. It is deliberately additive: when no credential is present, or
// the provider fails, callers keep the existing deterministic draft and the
// artifact truthfully records provider 'deterministic-local'.
//
// Nothing here grants authority. Output is always a draft.

const CHANNEL_RULES = {
  linkedin:  { maxChars: 700, style: 'Professional, insight-led. No emojis. Short paragraphs. Open with a strong or counterintuitive insight. Close with a reflection or question. 3-5 hashtags.' },
  facebook:  { maxChars: 500, style: 'Warm and conversational. At most 1-2 emojis. Short sentences. Always end with a question that invites a comment.' },
  instagram: { maxChars: 400, style: 'Visual and inspiring. 3-5 emojis placed deliberately. The first line must stop the scroll. Include a save/share/comment CTA. 5-8 hashtags.' },
  tiktok:    { maxChars: 300, style: 'Ultra-short hook in the first sentence. Trendy, authentic voice. Speak directly to the viewer. Encourage follow/comment/share. 5-8 hashtags.' },
  x:         { maxChars: 280, style: 'One idea only. Punchy and direct. No filler. At most 1-2 hashtags.' },
  threads:   { maxChars: 500, style: 'Conversational and opinionated. Reads like a thought, not an ad. Minimal hashtags.' },
  pinterest: { maxChars: 400, style: 'Descriptive and search-friendly. Lead with the benefit. Keyword-rich but natural.' },
  youtube:   { maxChars: 700, style: 'Video description. Hook in the first two lines before the fold. Then context, then CTA and links.' },
}

const LANGUAGE_NAMES = {
  'nb-NO': 'Norwegian Bokmål',
  'nn-NO': 'Norwegian Nynorsk',
  'pt-BR': 'Brazilian Portuguese',
  'pt-PT': 'European Portuguese',
  'en': 'English',
  'en-US': 'English',
  'en-GB': 'British English',
  'es': 'Spanish',
  'es-ES': 'Spanish',
  'sv-SE': 'Swedish',
  'da-DK': 'Danish',
  'de-DE': 'German',
  'fr-FR': 'French',
}

const languageName = tag => LANGUAGE_NAMES[tag] || LANGUAGE_NAMES[String(tag).split('-')[0]] || tag

const FACT_GUARD =
  'Do not invent statistics, facts, customer names, dates or claims that were not supplied. ' +
  'Do not use superlatives such as "first in Norway", "largest" or "best" unless they appear in the supplied context. ' +
  'If you lack a concrete detail, write around it rather than fabricating one.'

function buildPrompt({ objective, channel, language, brand, sourceText, variantIndex, variantCount }) {
  const rules = CHANNEL_RULES[channel] || CHANNEL_RULES.instagram
  const target = languageName(language)

  const brandBlock = brand
    ? [
        brand.name && `Business: ${brand.name}`,
        brand.about && `About: ${brand.about}`,
        brand.audience && `Audience: ${brand.audience}`,
        brand.tone && `Tone of voice: ${brand.tone}`,
        brand.offers?.length && `Offers: ${brand.offers.join(', ')}`,
        brand.objectives?.length && `Objectives: ${brand.objectives.join(', ')}`,
        brand.keywords && `Keywords: ${brand.keywords}`,
      ].filter(Boolean).join('\n')
    : ''

  const system = [
    `You are an expert social media copywriter writing a single ${channel} post.`,
    brandBlock,
    ``,
    `OUTPUT LANGUAGE: ${target}. Write the post entirely in ${target}. This is not a translation task — write natively in that language, using idiom a native speaker would use.`,
    `CHANNEL RULES: ${rules.style}`,
    `MAXIMUM LENGTH: ${rules.maxChars} characters including hashtags.`,
    ``,
    FACT_GUARD,
    ``,
    `Reply with the post text only. No preamble, no explanation, no surrounding quotes, no markdown fences.`,
  ].filter(Boolean).join('\n')

  const distinctness = variantCount > 1
    ? `\n\nThis is variant ${variantIndex} of ${variantCount}. Each variant must take a genuinely different angle — a different hook, structure and argument. Do not restate the other variants.`
    : ''

  const user = [
    `OBJECTIVE: ${objective}`,
    sourceText ? `\nADAPT THIS SOURCE CONTENT:\n${sourceText}` : '',
    distinctness,
    `\n\nWrite the ${channel} post in ${target} now.`,
  ].filter(Boolean).join('')

  return { system, user }
}

function truncate(text, channel) {
  const max = (CHANNEL_RULES[channel] || CHANNEL_RULES.instagram).maxChars
  const clean = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const sentence = cut.search(/[.!?]\s[^.!?]*$/)
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1)
  const space = cut.lastIndexOf(' ')
  return space > max * 0.6 ? cut.slice(0, space) : cut
}

const MAX_OUTPUT_TOKENS = 4000

async function callAnthropic({ system, user, apiKey, model, signal }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    // A post is at most 700 characters, but the budget also has to cover the
    // model's thinking. At 1000 the thinking alone hit the ceiling and the
    // reply came back with no text block at all, scored here as a failure.
    body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: 'user', content: user }] }),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try { const body = await response.json(); detail = body?.error?.message || detail } catch {}
    const error = new Error(`Content provider call failed: ${detail}`)
    error.code = 'CONTENT_PROVIDER_FAILED'
    error.status = response.status
    throw error
  }
  const body = await response.json()
  return {
    // The first block is not always the answer: current models put a thinking
    // block ahead of the text one, and reading index 0 yielded an empty string
    // that this module scored as a provider failure.
    text: (Array.isArray(body?.content) ? body.content : []).find(block => block?.type === 'text')?.text || '',
    usage: {
      tokensIn: Number(body?.usage?.input_tokens ?? 0),
      tokensOut: Number(body?.usage?.output_tokens ?? 0),
      cachedInputTokens: Number(body?.usage?.cache_read_input_tokens ?? 0),
    },
  }
}

// Sonnet 5 is the current Sonnet on this account. The dated Sonnet 4 id this
// shipped with 404s as not_found_error, which made every generation attempt
// fall back to the fixture and look like a missing credential.
export const CONTENT_MODEL = 'claude-sonnet-5'

export function contentGenerationAvailable(env = process.env) {
  const key = env.ANTHROPIC_API_KEY
  return typeof key === 'string' && key.startsWith('sk-') && key.length > 20
}

/**
 * Generate real copy for a set of draft variants.
 *
 * Returns null when generation is unavailable or fails — the caller then keeps
 * its deterministic draft unchanged. Never throws for provider reasons, so a
 * missing credential can never break a delegation.
 *
 * @returns {Promise<null | { variants: Array, provider: string, model: string, usage: object }>}
 */
export async function generateVariantCopy({
  variants,
  objective,
  languages,
  brand = null,
  sourceText = null,
  env = process.env,
  signal = undefined,
  call = callAnthropic,
} = {}) {
  if (!Array.isArray(variants) || !variants.length) return null
  if (!contentGenerationAvailable(env)) return null

  const apiKey = env.ANTHROPIC_API_KEY
  const language = languages?.outputLanguage || variants[0]?.language || 'en'
  const usage = { tokensIn: 0, tokensOut: 0, cachedInputTokens: 0, providerCalls: 0, mode: 'live-draft' }

  const results = await Promise.allSettled(
    variants.map((variant, index) => {
      const { system, user } = buildPrompt({
        objective,
        channel: variant.channel,
        language: variant.language || language,
        brand,
        sourceText,
        variantIndex: index + 1,
        variantCount: variants.length,
      })
      return call({ system, user, apiKey, model: CONTENT_MODEL, signal })
    })
  )

  const generated = variants.map((variant, index) => {
    const result = results[index]
    if (result.status !== 'fulfilled' || !result.value?.text?.trim()) {
      // Falling back silently made a provider outage indistinguishable from a
      // missing credential. The reason is logged, never the prompt or the key.
      console.warn('[content] variant kept its fixture:', result.status === 'rejected' ? result.reason?.message || 'provider call failed' : 'provider returned no text')
      return { ...variant, generated: false }
    }
    usage.tokensIn += result.value.usage.tokensIn
    usage.tokensOut += result.value.usage.tokensOut
    usage.cachedInputTokens += result.value.usage.cachedInputTokens
    usage.providerCalls += 1
    return { ...variant, text: truncate(result.value.text, variant.channel), generated: true }
  })

  // Partial success still counts: any real copy is better than every fixture.
  if (!usage.providerCalls) return null

  return {
    variants: generated,
    provider: 'claude',
    model: CONTENT_MODEL,
    usage,
    complete: usage.providerCalls === variants.length,
  }
}
