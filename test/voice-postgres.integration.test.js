import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import pg from 'pg'
import { executeCanonicalVoiceAgentTurn } from '../src/voice/agentOrchestrator.js'
import { saveSosyDelegation, updateSosyDelegation } from '../src/sosy/store.js'
import { saveArtifact } from '../src/marketing/artifacts.js'
import { recordVoiceUsage } from '../src/voice/cost.js'

dotenv.config({ override: true })

const EXPECTED_DATABASE = 'yeeyoo_phase13_test'
const ALPHA_USER = '00000000-0000-4000-8000-000000000001'
const ALPHA_PROJECT = '10000000-0000-4000-8000-000000000001'
const REQUEST = 'Tony, be Sosy lage fem Instagram-poster for Yeeyoo Brasil neste uke. Snakk med meg på norsk, men lag alt på brasiliansk portugisisk.'

async function isolatedTransaction(t) {
  assert.ok(process.env.YEEYOO_TEST_DATABASE_URL, 'test DB URL required')
  const db = new pg.Client({
    connectionString: process.env.YEEYOO_TEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  })
  await db.connect()
  t.after(() => db.end())
  const identity = await db.query('SELECT current_database() AS name')
  assert.equal(identity.rows[0]?.name, EXPECTED_DATABASE, 'refusing every non-disposable database')
  await db.query('BEGIN')
  t.after(() => db.query('ROLLBACK').catch(() => {}))
  return db
}

test('Norwegian Tony voice persists one pt-BR Sosy draft and separate replay-safe cost stages', async t => {
  const db = await isolatedTransaction(t)
  const result = await executeCanonicalVoiceAgentTurn({
    userId: ALPHA_USER,
    projectId: ALPHA_PROJECT,
    agent: 'tony',
    transcript: REQUEST,
    language: 'AUTO',
  }, {
    saveDelegation: delegation => saveSosyDelegation(delegation, db),
    updateDelegation: args => updateSosyDelegation({ ...args, db }),
    saveArtifact: input => saveArtifact(input, db),
  })

  assert.equal(result.conversationLanguage, 'nb-NO')
  assert.equal(result.outputLanguage, 'pt-BR')
  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.delegation.status, 'waiting_approval')
  assert.equal(result.artifact.status, 'draft')
  assert.equal(result.artifact.content.variants.length, 5)
  assert.ok(result.artifact.content.variants.every(item => item.language === 'pt-BR'))

  const key = `phase28b-${crypto.randomUUID()}`
  const turn = { id: result.voiceTurnId, sessionId: result.sessionId, userId: ALPHA_USER, projectId: ALPHA_PROJECT, agent: 'tony' }
  for (const stage of ['stt', 'agent', 'tts']) {
    await recordVoiceUsage({ turn, stage, idempotencyKey: `${key}:${stage}`, usage: stage === 'stt' ? { audioSeconds: 4 } : stage === 'tts' ? { characters: result.replyText.length } : {} }, { db })
  }
  const ledger = await db.query(`SELECT operation, billable, cost_usd FROM ai_usage_ledger
    WHERE user_id=$1 AND project_id=$2 AND idempotency_key LIKE $3 ORDER BY operation`, [ALPHA_USER, ALPHA_PROJECT, `${key}:%`])
  assert.deepEqual(ledger.rows.map(row => row.operation), ['voice.agent', 'voice.stt', 'voice.tts'])
  assert.ok(ledger.rows.every(row => row.billable === false && Number(row.cost_usd) === 0))
})
