import express, { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { executeCanonicalVoiceAgentTurn } from '../voice/agentOrchestrator.js'
import crypto from 'node:crypto'
import { pool } from '../db.js'
import { recordProjectActivity } from '../lib/projectActivity.js'
import { saveSosyDelegation, updateSosyDelegation } from '../sosy/store.js'
import { saveArtifact } from '../marketing/artifacts.js'
import { createDeterministicVoiceAdapters, createSpeechToTextAdapter } from '../voice/adapters.js'
import { recordVoiceUsage } from '../voice/cost.js'
import { withEphemeralAudio } from '../voice/audioLifecycle.js'

const r = Router()
r.use(auth)

const audioTypes = ['audio/webm', 'audio/ogg', 'audio/mp4']
// Typed transcription failures the client may see. Anything unlisted collapses
// to a generic message so provider internals and keys can never reach a body.
const transcribeStatus = {
  VOICE_STT_NOT_CONFIGURED: 503, VOICE_STT_PROVIDER_FAILED: 502, VOICE_STT_TIMEOUT: 504, VOICE_CANCELLED: 499,
  VOICE_AUDIO_EMPTY: 400, VOICE_AUDIO_DURATION_INVALID: 400, VOICE_AUDIO_TOO_LONG: 413, VOICE_AUDIO_TOO_LARGE: 413,
  VOICE_NO_SPEECH: 422, VOICE_TRANSCRIPT_TOO_LARGE: 413, VOICE_LANGUAGE_UNSUPPORTED: 400, VOICE_TRANSCRIBE_REPLAY: 409,
}
r.post('/transcribe', express.raw({ type: audioTypes, limit: '8mb' }), async (req, res) => {
  try {
    const project = await requireProject(req, req.query.projectId)
    const mimeType = String(req.get('content-type') || '').split(';')[0].toLowerCase()
    if (!audioTypes.includes(mimeType)) return res.status(415).json({ error: 'Recorded audio format is not supported', code: 'VOICE_AUDIO_FORMAT_UNSUPPORTED' })
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Recorded audio is empty', code: 'VOICE_AUDIO_EMPTY' })
    const durationSeconds = Number(req.query.durationSeconds || 0)
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return res.status(400).json({ error: 'Recorded audio duration is invalid', code: 'VOICE_AUDIO_DURATION_INVALID' })
    const requestKey = String(req.get('Idempotency-Key') || '').trim()
    if (!requestKey) return res.status(400).json({ error: 'Voice turn identity is required', code: 'VOICE_TURN_ID_REQUIRED' })
    // Replay guard before the provider is touched: a repeated key must not pay
    // twice. Transcripts are never stored, so a replay cannot be re-served.
    const replay = await pool.query(`SELECT 1 FROM ai_usage_ledger WHERE user_id=$1 AND project_id=$2 AND operation='voice.stt' AND idempotency_key=$3 LIMIT 1`, [req.user.id, project.id, `${requestKey}:stt`])
    if (replay.rows[0]) throw Object.assign(new Error('Voice transcription was already processed'), { code: 'VOICE_TRANSCRIBE_REPLAY' })
    const stt = createSpeechToTextAdapter()
    // req.body is the only copy of the recording; withEphemeralAudio zeroes it
    // in a finally on success, error, timeout and abort alike.
    const result = await withEphemeralAudio(req.body, audio => stt.transcribe({ audio, mimeType, languageHint: req.query.language || 'AUTO', durationSeconds }))
    await recordVoiceUsage({ turn: { id: requestKey, sessionId: requestKey, userId: req.user.id, projectId: project.id, agent: ['tony', 'sosy'].includes(req.query.agent) ? req.query.agent : 'tony' }, stage: 'stt', idempotencyKey: `${requestKey}:stt`, usage: { audioSeconds: result.usage.audioSeconds, provider: result.provider, model: result.model } })
    // Vendor identity stays server side: only the ledger sees provider/model.
    res.set('Cache-Control', 'no-store').json({ transcript: result.transcript, language: result.detectedLanguage, confidence: result.confidence, requiresLanguageClarification: !result.detectedLanguage, durationSeconds: result.durationSeconds, ephemeral: true })
  } catch (error) {
    if (sendProjectError(res, error)) return
    const status = transcribeStatus[error.code]
    res.status(status || 500).json({ error: status ? error.message : 'Speech transcription failed', code: status ? error.code : 'VOICE_STT_FAILED' })
  }
})

// Intended mount: /api/voice. Audio/STT/TTS adapters normalize into this
// canonical turn; this route never receives provider authority from audio.
r.post('/turn', async (req, res) => {
  let client
  try {
    const body = req.body || {}
    if (!['fixture', 'browser-speech', 'media-recorder'].includes(body.inputMode)) {
      return res.status(400).json({ error: 'Voice inputMode is invalid', code: 'VOICE_INPUT_MODE_INVALID' })
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
