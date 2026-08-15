import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { executeCanonicalVoiceAgentTurn } from '../voice/agentOrchestrator.js'
import crypto from 'node:crypto'
import { pool } from '../db.js'
import { recordProjectActivity } from '../lib/projectActivity.js'
import { saveSosyDelegation, updateSosyDelegation } from '../sosy/store.js'
import { saveArtifact } from '../marketing/artifacts.js'
import { createDeterministicVoiceAdapters } from '../voice/adapters.js'
import { recordVoiceUsage } from '../voice/cost.js'

const r = Router()
r.use(auth)

// Intended mount: /api/voice. Audio/STT/TTS adapters normalize into this
// canonical turn; this route never receives provider authority from audio.
r.post('/turn', async (req, res) => {
  let client
  try {
    const body = req.body || {}
    if (!['fixture', 'browser-speech'].includes(body.inputMode)) {
      return res.status(400).json({ error: 'Voice inputMode must be fixture or browser-speech', code: 'VOICE_INPUT_MODE_INVALID' })
    }
    const project = await requireProject(req, body.projectId)
    client = await pool.connect()
    await client.query('BEGIN')
    const requestKey = String(req.get('Idempotency-Key') || '').trim()
    if (requestKey) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`voice:${req.user.id}:${project.id}:${requestKey}`])
      const replay = await client.query(`SELECT 1 FROM ai_usage_ledger WHERE user_id=$1 AND project_id=$2 AND operation='voice.agent' AND idempotency_key=$3 LIMIT 1`, [req.user.id, project.id, `${requestKey}:agent`])
      if (replay.rows[0]) throw Object.assign(new Error('Voice turn was already processed'), { code: 'VOICE_TURN_REPLAY', status: 409 })
    }
    if (body.tonyPlanId) {
      const ownedPlan = await client.query('SELECT id FROM tony_execution_plans WHERE id=$1 AND user_id=$2 AND project_id=$3', [body.tonyPlanId, req.user.id, project.id])
      if (!ownedPlan.rows[0]) throw Object.assign(new Error('Tony plan not found'), { code: 'TONY_PLAN_NOT_FOUND', status: 404 })
    }
    if (body.campaignId) {
      const ownedCampaign = await client.query('SELECT id FROM marketing_campaigns WHERE id=$1 AND user_id=$2 AND project_id=$3', [body.campaignId, req.user.id, project.id])
      if (!ownedCampaign.rows[0]) throw Object.assign(new Error('Campaign not found'), { code: 'CAMPAIGN_NOT_FOUND', status: 404 })
    }
    const result = await executeCanonicalVoiceAgentTurn({
      ...body,
      projectId: project.id,
      userId: req.user.id,
      sourceTrust: body.sourceTrust === 'external-evidence' ? 'external-evidence' : 'owner',
    }, {
      saveDelegation: delegation => saveSosyDelegation(delegation, client),
      updateDelegation: args => updateSosyDelegation({ ...args, db: client }),
      saveArtifact: input => saveArtifact(input, client),
      getProjectSummary: async ({ userId, projectId }) => {
        const { rows } = await client.query(`SELECT
          (SELECT COUNT(*)::int FROM marketing_campaigns WHERE user_id=$1 AND project_id=$2) AS campaigns,
          (SELECT COUNT(*)::int FROM marketing_artifacts WHERE user_id=$1 AND project_id=$2) AS artifacts,
          (SELECT COUNT(*)::int FROM sosy_delegations WHERE user_id=$1 AND project_id=$2 AND status NOT IN ('completed','failed')) AS active_sosy`, [userId, projectId])
        return rows[0]
      },
    })
    const { tts } = createDeterministicVoiceAdapters()
    const speechLanguage = result.conversationLanguage || (body.language && body.language !== 'AUTO' ? body.language : 'en')
    const speech = await tts.synthesize({ text: result.replyText, language: speechLanguage, voiceIdentity: result.agent === 'tony' ? 'tony-standard' : 'sosy-standard' })
    let persisted
    if (result.agent === 'tony') {
      let conversationId = body.conversationId || null
      if (conversationId) {
        const owned = await client.query('SELECT id FROM tony_conversations WHERE id=$1 AND user_id=$2 AND project_id=$3', [conversationId, req.user.id, project.id])
        if (!owned.rows[0]) throw Object.assign(new Error('Voice conversation not found'), { code: 'VOICE_CONVERSATION_NOT_FOUND', status: 404 })
      } else {
        conversationId = crypto.randomUUID()
        await client.query('INSERT INTO tony_conversations (id,user_id,project_id,title,model) VALUES ($1,$2,$3,$4,$5)', [conversationId, req.user.id, project.id, `Tony voice: ${result.transcript.slice(0, 60)}`, 'voice-tony'])
      }
      const userMessageId = crypto.randomUUID(), agentMessageId = crypto.randomUUID()
      await client.query(`INSERT INTO tony_messages (id,conversation_id,role,content) VALUES ($1,$2,'user',$3),($4,$2,'assistant',$5)`, [userMessageId, conversationId, result.transcript, agentMessageId, result.replyText])
      await client.query('UPDATE tony_conversations SET updated_at=NOW() WHERE id=$1 AND user_id=$2 AND project_id=$3', [conversationId, req.user.id, project.id])
      persisted = { conversationId, userMessageId, agentMessageId }
    } else {
      if (body.conversationId) throw Object.assign(new Error('Sosy voice uses canonical project activity'), { code: 'VOICE_CONVERSATION_NOT_FOUND', status: 404 })
      await recordProjectActivity({ userId: req.user.id, projectId: project.id, eventType: 'sosy_voice_turn', subjectType: result.delegation ? 'sosy_delegation' : 'project', subjectId: result.delegation?.id || project.id, summary: 'Sosy voice turn completed', metadata: { source: 'voice', transcript: result.transcript, replyText: result.replyText, conversationLanguage: result.conversationLanguage, outputLanguage: result.outputLanguage }, dedupeKey: `sosy:voice:${result.voiceTurnId}`, db: client })
      persisted = { activityRecorded: true }
    }
    const costTurn = { id: result.voiceTurnId, sessionId: result.sessionId, userId: req.user.id, projectId: project.id, agent: result.agent }
    await recordVoiceUsage({ turn: costTurn, stage: 'stt', idempotencyKey: requestKey ? `${requestKey}:stt` : undefined, usage: { audioSeconds: Number(body.durationSeconds || 0), provider: 'deterministic-local', model: 'fixture-stt-v1' } }, { db: client })
    await recordVoiceUsage({ turn: costTurn, stage: 'agent', idempotencyKey: requestKey ? `${requestKey}:agent` : undefined, usage: { provider: 'deterministic-local', model: `${result.agent}-voice-orchestrator-v1` } }, { db: client })
    await recordVoiceUsage({ turn: costTurn, stage: 'tts', idempotencyKey: requestKey ? `${requestKey}:tts` : undefined, usage: { characters: speech.usage.characters, provider: speech.provider, model: speech.model } }, { db: client })
    await client.query('COMMIT')
    // Clarification is a successful conversational outcome, not a transport
    // error; the client must be able to render and speak the replyText.
    res.status(200).json({ ...result, ...persisted, audio: speech.audio, voiceProvider: speech.provider, streaming: false })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (sendProjectError(res, error)) return
    const status = Number(error.status) || 400
    res.status(status >= 400 && status < 500 ? status : 500).json({ error: status < 500 ? error.message : 'Voice turn failed', code: error.code || 'VOICE_TURN_FAILED' })
  } finally {
    client?.release()
  }
})

export default r
