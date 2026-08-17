// Gate 7 Scenario 3, proven inside a transaction that is always rolled back.
//
// The HTTP pass in gate7-http-certification.mjs exercises the real route; this
// pass exercises the same orchestrator with every dependency bound to a single
// transaction client — exactly how src/routes/voice-agent.js binds them — so
// the persisted rows can be read back and quoted, then discarded. Nothing this
// script does can survive: the only COMMIT-free path out is ROLLBACK.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env') })
process.env.NODE_ENV = 'test'
process.env.YEEYOO_STRICT_TEST_DB = 'true'
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'FAL_KEY', 'STRIPE_SECRET_KEY', 'VOICE_STT_PROVIDER', 'VOICE_TTS_PROVIDER']) process.env[key] = ''

const { pool } = await import('../src/db.js')
const { executeCanonicalVoiceAgentTurn } = await import('../src/voice/agentOrchestrator.js')
const { saveSosyDelegation, updateSosyDelegation } = await import('../src/sosy/store.js')
const { saveArtifact } = await import('../src/marketing/artifacts.js')

const USER = '00000000-0000-4000-8000-000000000001'
const PROJECT = '10000000-0000-4000-8000-000000000001'
const TRANSCRIPT = 'Tony, be Sosy lage fem Instagram-poster for Yeeyoo Brasil neste uke. Snakk med meg på norsk, men lag innleggene på brasiliansk portugisisk.'

const results = []
const record = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`) }

const client = await pool.connect()
try {
  await client.query('BEGIN')
  // Identity first, inside the transaction, before a single row is touched.
  const identity = await client.query('SELECT current_database() AS name, current_user AS role')
  if (identity.rows[0].name !== 'yeeyoo_phase13_test') { await client.query('ROLLBACK'); throw new Error(`IDENTITY_REJECTED: ${identity.rows[0].name}`) }
  console.log(`database identity asserted inside transaction: ${identity.rows[0].name} (role ${identity.rows[0].role})\n`)

  const baseline = await client.query('SELECT (SELECT COUNT(*)::int FROM sosy_delegations) AS delegations, (SELECT COUNT(*)::int FROM marketing_artifacts) AS artifacts')
  console.log('baseline inside transaction:', JSON.stringify(baseline.rows[0]), '\n')

  const result = await executeCanonicalVoiceAgentTurn({
    agent: 'tony', inputMode: 'fixture', transcript: TRANSCRIPT, language: 'AUTO',
    userId: USER, projectId: PROJECT, sourceTrust: 'owner',
  }, {
    saveDelegation: delegation => saveSosyDelegation(delegation, client),
    updateDelegation: args => updateSosyDelegation({ ...args, db: client }),
    saveArtifact: input => saveArtifact(input, client),
  })

  record('conversation_language = nb-NO', result.conversationLanguage === 'nb-NO', `conversationLanguage=${result.conversationLanguage}`)
  record('output_language = pt-BR', result.outputLanguage === 'pt-BR', `outputLanguage=${result.outputLanguage}`)
  record('intent is sosy_delegation', result.intent === 'sosy_delegation', `intent=${result.intent}`)
  record('status waiting_approval', result.status === 'waiting_approval', `status=${result.status}`)
  record('authorityGranted === false', result.authorityGranted === false, `authorityGranted=${result.authorityGranted}`)
  record('requiresApproval === true', result.requiresApproval === true, `requiresApproval=${result.requiresApproval}`)
  record('Norwegian conversational reply', /^Sosy lager et utkast på pt-BR/.test(result.replyText), `replyText=${JSON.stringify(result.replyText)}`)

  const delegations = await client.query('SELECT * FROM sosy_delegations WHERE user_id=$1 AND project_id=$2', [USER, PROJECT])
  record('exactly one canonical Sosy delegation', delegations.rowCount === 1, `rowCount=${delegations.rowCount} (baseline was ${baseline.rows[0].delegations})`)
  const delegation = delegations.rows[0]
  console.log('\nPERSISTED sosy_delegations ROW:\n' + JSON.stringify(delegation, null, 2))

  const artifacts = await client.query('SELECT * FROM marketing_artifacts WHERE id=$1', [delegation.result_artifact_id])
  const artifact = artifacts.rows[0]
  console.log('\nPERSISTED marketing_artifacts ROW:\n' + JSON.stringify(artifact, null, 2))

  record('delegation created through the existing Sosy path', delegation.specialist === 'sosy' && delegation.task_type === 'content.create' && delegation.schema_version === 1, `specialist=${delegation.specialist} task_type=${delegation.task_type} schema_version=${delegation.schema_version}`)
  record('delegation languages persisted', delegation.conversation_language === 'nb-NO' && delegation.output_language === 'pt-BR', `conversation_language=${delegation.conversation_language} output_language=${delegation.output_language}`)
  record('delegation status waiting_approval', delegation.status === 'waiting_approval', `status=${delegation.status}`)
  record('draft Marketing Artifact persisted', Boolean(artifact) && artifact.status === 'draft', `id=${artifact?.id} status=${artifact?.status}`)
  const variants = artifact?.content?.variants || []
  record('exactly five Instagram variants', variants.length === 5 && variants.every(v => v.channel === 'instagram'), `variants=${variants.length} channels=${JSON.stringify([...new Set(variants.map(v => v.channel))])}`)
  record('every variant tagged pt-BR', variants.length > 0 && variants.every(v => v.language === 'pt-BR'), `languages=${JSON.stringify([...new Set(variants.map(v => v.language))])}`)
  record('variant sequence 1..5', JSON.stringify(variants.map(v => v.sequence)) === JSON.stringify([1, 2, 3, 4, 5]), `sequences=${JSON.stringify(variants.map(v => v.sequence))}`)
  record('no publish authority anywhere on the result', !('publish' in result) && result.authorityGranted === false && artifact?.approved_at === null && artifact?.approved_by === null, `approved_at=${artifact?.approved_at} approved_by=${artifact?.approved_by}`)

  // Honest read of what the "Brazilian Portuguese" copy actually contains.
  const uniqueTexts = [...new Set(variants.map(v => v.text))]
  console.log(`\nvariant text distinct values: ${uniqueTexts.length}`)
  console.log(`variant text verbatim: ${JSON.stringify(uniqueTexts[0])}`)

  await client.query('ROLLBACK')
  console.log('\ntransaction rolled back')
} finally {
  const after = await client.query('SELECT (SELECT COUNT(*)::int FROM sosy_delegations) AS delegations, (SELECT COUNT(*)::int FROM marketing_artifacts) AS artifacts')
  console.log('post-rollback counts:', JSON.stringify(after.rows[0]))
  client.release()
  await pool.end()
  const failed = results.filter(entry => !entry.pass)
  console.log(`\n══ ${results.length - failed.length}/${results.length} checks passed ══`)
  if (failed.length) for (const entry of failed) console.log(`  FAILED: ${entry.name}`)
}
