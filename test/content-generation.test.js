import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CONTENT_MODEL, contentGenerationAvailable, generateVariantCopy } from '../src/marketing/contentGenerator.js'
import { createSpecialistJobHandler } from '../src/marketing/specialistJobHandler.js'
import { loadBrandContext } from '../src/marketing/profileStore.js'
import { buildSosyDraft, createSosyDelegation } from '../src/sosy/domain.js'

const LIVE = { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789012345678901234567890' }
const FIXTURE = [
  { channel: 'instagram', language: 'pt-BR', text: '[Instagram · pt-BR] Lansere Yeeyoo i Brasil', status: 'draft' },
  { channel: 'linkedin', language: 'pt-BR', text: '[LinkedIn · pt-BR] Lansere Yeeyoo i Brasil', status: 'draft' },
]

// A stub in place of the HTTP call, so the boundary is exercised without a
// credential and without a network. The real call has the same shape.
function stubCall(reply) {
  const seen = []
  const call = async ({ system, user, model }) => {
    seen.push({ system, user, model })
    return { text: typeof reply === 'function' ? reply(seen.length) : reply, usage: { tokensIn: 100, tokensOut: 40, cachedInputTokens: 0 } }
  }
  return { call, seen }
}

test('no credential means no generation and no exception', async () => {
  assert.equal(contentGenerationAvailable({}), false)
  assert.equal(contentGenerationAvailable({ ANTHROPIC_API_KEY: 'sk-ant-...' }), false, 'the placeholder in .env must not read as configured')
  assert.equal(contentGenerationAvailable(LIVE), true)
  // Returning null rather than throwing is what keeps the fixture path intact.
  assert.equal(await generateVariantCopy({ variants: FIXTURE, objective: 'Launch', env: {} }), null)
  assert.equal(await generateVariantCopy({ variants: [], objective: 'Launch', env: LIVE }), null)
})

test('a provider failure leaves the caller with its fixture, never an error', async () => {
  const failing = async () => { throw Object.assign(new Error('Content provider call failed: HTTP 529'), { code: 'CONTENT_PROVIDER_FAILED' }) }
  assert.equal(await generateVariantCopy({ variants: FIXTURE, objective: 'Launch', env: LIVE, call: failing }), null)
  // Empty text is a failure too: an empty post must never replace a draft.
  const blank = async () => ({ text: '   ', usage: { tokensIn: 1, tokensOut: 0, cachedInputTokens: 0 } })
  assert.equal(await generateVariantCopy({ variants: FIXTURE, objective: 'Launch', env: LIVE, call: blank }), null)
})

test('generated copy is attributed to claude and carries real usage', async () => {
  const { call, seen } = stubCall(index => `Post numero ${index} escrito em portugues.`)
  const result = await generateVariantCopy({
    variants: FIXTURE, objective: 'Lansere Yeeyoo i Brasil',
    languages: { outputLanguage: 'pt-BR' }, brand: { name: 'yeeyoo.no', about: 'AI marketing' },
    env: LIVE, call,
  })
  assert.equal(result.provider, 'claude', 'the artifact must not claim a fixture it did not use')
  assert.equal(result.model, CONTENT_MODEL)
  assert.equal(result.complete, true)
  assert.deepEqual(result.usage, { tokensIn: 200, tokensOut: 80, cachedInputTokens: 0, providerCalls: 2, mode: 'live-draft' })
  // The fixture echo is gone and the variants differ from each other.
  assert.ok(result.variants.every(variant => variant.generated === true))
  assert.ok(result.variants.every(variant => !variant.text.startsWith('[')))
  assert.notEqual(result.variants[0].text, result.variants[1].text)
  // Channel and language survive; only the text is replaced.
  assert.deepEqual(result.variants.map(variant => variant.channel), ['instagram', 'linkedin'])
  assert.ok(result.variants.every(variant => variant.language === 'pt-BR' && variant.status === 'draft'))
  // Written natively, not translated, and each variant told to differ.
  assert.ok(seen.every(entry => entry.system.includes('Brazilian Portuguese')))
  assert.ok(seen.every(entry => !/translate this/i.test(entry.system)))
  assert.match(seen[0].user, /variant 1 of 2/)
  assert.match(seen[1].user, /variant 2 of 2/)
  // Channel budgets are per channel, and the brand context reaches the prompt.
  assert.match(seen[0].system, /MAXIMUM LENGTH: 400 characters/)
  assert.match(seen[1].system, /MAXIMUM LENGTH: 700 characters/)
  assert.match(seen[0].system, /yeeyoo\.no/)
})

test('partial success is kept and over-long copy is cut to the channel budget', async () => {
  let calls = 0
  const half = async () => (++calls === 1 ? { text: 'a'.repeat(900), usage: { tokensIn: 10, tokensOut: 5, cachedInputTokens: 0 } } : Promise.reject(new Error('boom')))
  const result = await generateVariantCopy({ variants: FIXTURE, objective: 'Launch', env: LIVE, call: half })
  assert.equal(result.provider, 'claude')
  assert.equal(result.complete, false, 'one of two succeeded')
  assert.equal(result.usage.providerCalls, 1)
  assert.equal(result.variants[0].generated, true)
  assert.ok(result.variants[0].text.length <= 400, 'instagram budget enforced')
  // The failed variant keeps its deterministic text untouched.
  assert.equal(result.variants[1].text, FIXTURE[1].text)
  assert.equal(result.variants[1].generated, false)
})

test('loadBrandContext returns null for an empty profile, not for a missing one', async () => {
  // getMarketingProfile never returns null - it falls back to an empty canonical
  // profile - so emptiness is what has to disqualify a project here.
  const empty = { query: async () => ({ rows: [] }) }
  assert.equal(await loadBrandContext({ userId: 'u1', projectId: 'p1', db: empty }), null)

  const populated = { query: async sql => sql.includes('project_marketing_profiles')
    ? { rows: [{ profile: { websiteUrl: 'https://www.yeeyoo.no/priser', brand: { summary: 'AI marketing for small teams', voice: ['direct', 'warm'] }, audiences: ['Founders'], offers: [{ claim: 'Free audit' }], objectives: ['Leads'], keywords: ['ai', 'marketing'] } }] }
    : { rows: [] } }
  const brand = await loadBrandContext({ userId: 'u1', projectId: 'p1', db: populated })
  assert.deepEqual(brand, {
    name: 'yeeyoo.no', about: 'AI marketing for small teams', audience: 'Founders',
    tone: 'direct, warm', offers: ['Free audit'], objectives: ['Leads'], keywords: 'ai, marketing',
  })

  // A broken profile degrades the copy; it must never fail the delegation.
  const broken = { query: async () => { throw new Error('relation "project_marketing_profiles" does not exist') } }
  assert.equal(await loadBrandContext({ userId: 'u1', projectId: 'p1', db: broken }), null)
})

test('the specialist handler stores what actually wrote the plan', async () => {
  const writes = []
  const db = { async query(sql, params) {
    if (sql.includes('project_marketing_profiles')) return { rows: [{ profile: { version: 2, objectives: ['Leads'], audiences: ['Founders'], offers: ['Audit'], channels: ['linkedin', 'instagram'], brand: { summary: 'AI marketing', voice: ['direct'] } } }] }
    if (sql.includes('FROM competitors') || sql.includes('FROM channel_connections')) return { rows: [] }
    if (sql.includes('INSERT INTO marketing_artifacts')) { writes.push(params); return { rows: [{ id: 'a1', root_id: 'a1', user_id: 'u1', project_id: 'p1', type: 'social', status: 'draft', content: {} }] } }
    throw new Error(sql)
  } }
  const generateCopy = async ({ variants }) => ({
    variants: variants.map((variant, index) => ({ ...variant, text: `Real post ${index + 1}`, generated: true })),
    provider: 'claude', model: CONTENT_MODEL, usage: { tokensIn: 10, tokensOut: 5, cachedInputTokens: 0, providerCalls: variants.length, mode: 'live-draft' }, complete: true,
  })
  const result = await createSpecialistJobHandler({ kind: 'social', db, env: LIVE, generateCopy })({ id: 'j1', userId: 'u1', projectId: 'p1', input: {} })

  assert.ok(writes[0].includes('claude'), 'provider column must say claude, not deterministic-local')
  assert.ok(writes[0].includes(CONTENT_MODEL))
  assert.ok(!writes[0].includes('deterministic-local'))
  assert.ok(!writes[0].includes('social-fixture-v1'))
  assert.equal(result.usage.mode, 'live-draft')
  assert.ok(result.usage.providerCalls > 0, 'the cost ledger needs the real call count')
  const content = JSON.parse(writes[0].find(param => typeof param === 'string' && param.includes('draftCalendar')))
  assert.ok(content.draftCalendar.every(entry => String(entry.text || '').startsWith('Real post')))
  assert.deepEqual(content.hooks, content.draftCalendar.map(entry => entry.text))
  assert.equal(content.mode, 'live-draft')
})

test('the Sosy run route hands the real provider to the artifact, the job and the client', () => {
  // The route is only reachable behind express auth, so what is locked here is
  // the wiring: no hardcoded provider may survive on the write path.
  const source = fs.readFileSync(new URL('../src/routes/sosy.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ generateVariantCopy \} from '\.\.\/marketing\/contentGenerator\.js'/)
  assert.match(source, /brand:await loadBrandContext\(\{userId:req\.user\.id,projectId\}\)/)
  assert.match(source, /provider=generated\.provider;model=generated\.model;usage=generated\.usage/)
  // saveArtifact, createJob and the succeeded transition all read the variables.
  assert.match(source, /provenance:\{jobId:job\.id\},provider,model\}/)
  assert.match(source, /kind:'marketing\.social',provider,model,/)
  assert.match(source, /to:'succeeded',artifacts:\[\{id:artifact\.id,type:artifact\.type\}\],usage\}/)
  // The old lie: mock:true regardless of what produced the draft.
  assert.doesNotMatch(source, /mock:true/)
  assert.match(source, /mock:provider==='deterministic-local'/)
  assert.doesNotMatch(source, /provider:'deterministic-local'/)
  assert.doesNotMatch(source, /model:'sosy-draft-v1'/)
})

test('the fixture draft still shapes what generation is asked to rewrite', () => {
  // generateVariantCopy consumes buildSosyDraft's output directly, so the two
  // shapes have to stay compatible even when no credential is present.
  const delegation = createSosyDelegation({
    userId: 'u1', projectId: 'p1', taskType: 'content.create', objective: 'Lansere Yeeyoo i Brasil',
    channels: ['instagram', 'linkedin'], languages: { conversationLanguage: 'nb-NO', outputLanguage: 'pt-BR' },
  })
  const draft = buildSosyDraft(delegation)
  assert.ok(draft.content.variants.every(variant => variant.channel && variant.language === 'pt-BR' && typeof variant.text === 'string'))
  assert.ok(draft.content.variants.every(variant => variant.text.startsWith('[')), 'the fixture still echoes the objective')
})

test('the provider reply is read from the text block, not the first block', () => {
  // Current models put a thinking block ahead of the text one. Reading
  // content[0] returned an empty string, which this module scores as a failed
  // call - so every generation silently fell back to the fixture with a working
  // key and a 200 response. The extraction is not injectable, so it is locked here.
  const source = fs.readFileSync(new URL('../src/marketing/contentGenerator.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /body\?\.content\?\.\[0\]\?\.text/)
  assert.match(source, /\.filter\(block => block\?\.type === 'text'\)\.map\(block => block\.text\)\.join\(''\)/)
  // A truncated reply must be able to say so instead of reading as a failure.
  assert.match(source, /stopReason: body\?\.stop_reason \|\| null/)
  assert.match(source, /stop_reason=\$\{result\.value\?\.stopReason/)
  // The output budget also covers the thinking block. At 1000 the thinking
  // alone reached the ceiling and the reply carried no text block at all.
  assert.doesNotMatch(source, /max_tokens: 1000/)
  assert.match(source, /const MAX_OUTPUT_TOKENS = 4000/)
  // The model must be one the API still serves; the dated Sonnet 4 id 404s.
  assert.doesNotMatch(source, /claude-sonnet-4-20250514/)
  assert.match(source, /export const CONTENT_MODEL = 'claude-sonnet-5'/)
})
