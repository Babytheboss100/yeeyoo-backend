import { buildSosyDraft, createSosyDelegation, transitionSosyDelegation } from '../sosy/domain.js'
import { saveSosyDelegation, updateSosyDelegation } from '../sosy/store.js'
import { saveArtifact } from '../marketing/artifacts.js'
import { pool } from '../db.js'
import { createVoiceTurn, detectVoiceLanguage, enforceVoiceLimits, normalizeVoiceLanguage } from './domain.js'

const executionPattern = /\b(publish|publiser|send\s+(?:the\s+)?dm|send\s+melding|spend|bruk\s+\d|connect\s+(?:facebook|instagram)|koble\s+til|delete|slett|approve|godkjenn)\b/i
const delegationPattern = /\b(?:ask|be)\s+sosy\b|\bsosy\b.*\b(?:create|make|lag|lage)\b/i
const creationPattern = /\b(create|make|draft|lag|lage|skriv|plan)\b/i
const ptOutputPattern = /(?:brazilian portuguese|brasiliansk portugisisk|portugu[eê]s(?:\s+brasileiro)?|pt-BR)/i

function voiceError(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function detectConversationLanguage(transcript, preference = 'AUTO') {
  const normalized = normalizeVoiceLanguage(preference)
  if (normalized !== 'AUTO') return { language: normalized, confidence: 1, source: 'preference' }
  const result = detectVoiceLanguage(transcript)
  return { language: result.language, confidence: result.confidence, source: result.requiresClarification ? 'ambiguous' : 'detected' }
}

export function classifyVoiceAgentCommand({ agent, transcript, language = 'AUTO', outputLanguage = null, sourceTrust = 'owner' }) {
  if (!['tony', 'sosy'].includes(agent)) throw voiceError('INVALID_AGENT', 'Voice agent must be Tony or Sosy')
  const cleanTranscript = String(transcript || '').trim()
  if (!cleanTranscript) throw voiceError('EMPTY_TRANSCRIPT', 'No speech was detected')
  enforceVoiceLimits({ transcript: cleanTranscript })
  if (!['owner', 'external-evidence'].includes(sourceTrust)) throw voiceError('INVALID_SOURCE_TRUST', 'Invalid transcript trust classification')
  const detected = detectConversationLanguage(cleanTranscript, language)
  if (!detected.language || detected.confidence < 0.7) {
    return { agent, intent: 'clarify_language', transcript: cleanTranscript, conversationLanguage: null, outputLanguage: null, sourceTrust, mutates: false, requiresApproval: false }
  }
  const normalizedOutput = outputLanguage || (ptOutputPattern.test(cleanTranscript) ? 'pt-BR' : detected.language)
  const safeOutput = normalizeVoiceLanguage(normalizedOutput, { allowAuto: false })
  if (sourceTrust === 'external-evidence') {
    return { agent, intent: 'external_evidence', transcript: cleanTranscript, conversationLanguage: detected.language, outputLanguage: safeOutput, sourceTrust, mutates: false, requiresApproval: false }
  }
  if (executionPattern.test(cleanTranscript)) {
    return { agent, intent: 'authority_required', transcript: cleanTranscript, conversationLanguage: detected.language, outputLanguage: safeOutput, sourceTrust, mutates: false, requiresApproval: true }
  }
  const delegation = agent === 'sosy' || delegationPattern.test(cleanTranscript)
  const intent = delegation ? 'sosy_delegation' : creationPattern.test(cleanTranscript) ? 'draft_creation' : 'informational'
  return { agent, intent, transcript: cleanTranscript, conversationLanguage: detected.language, outputLanguage: safeOutput, sourceTrust, mutates: intent === 'sosy_delegation', requiresApproval: intent !== 'informational' }
}

function replyFor(command) {
  const norwegian = command.conversationLanguage === 'nb-NO'
  if (command.intent === 'clarify_language') return 'Which language would you like to use? / Hvilket språk vil du bruke?'
  if (command.intent === 'authority_required') return norwegian ? 'Jeg kan forberede dette, men handlingen krever godkjenning i den eksisterende godkjenningsflyten.' : 'I can prepare that, but the action requires approval through the existing approval workflow.'
  if (command.intent === 'external_evidence') return norwegian ? 'Jeg har behandlet innholdet som uverifisert dokumentasjon, ikke som en autorisert instruksjon.' : 'I treated the content as untrusted evidence, not as an authorized instruction.'
  if (command.intent === 'informational') return norwegian ? 'Jeg kan oppsummere prosjektstatusen uten å utføre eller godkjenne handlinger.' : 'I can summarize project status without executing or approving actions.'
  if (command.intent === 'draft_creation') return norwegian ? 'Jeg kan opprette et utkast. Det blir ikke publisert og må gjennom godkjenning.' : 'I can prepare a draft. It will not be published and must pass approval.'
  return norwegian ? `Sosy lager et utkast på ${command.outputLanguage}. Resultatet blir sendt til godkjenning.` : `Sosy will create a ${command.outputLanguage} draft and send it to approval.`
}

export async function executeCanonicalVoiceAgentTurn(input, dependencies = {}) {
  const canonicalTurn = createVoiceTurn(input)
  const command = classifyVoiceAgentCommand(input)
  const { userId, projectId } = input
  const base = { voiceTurnId: canonicalTurn.id, sessionId: canonicalTurn.sessionId, transcript: command.transcript, replyText: replyFor(command), language: command.conversationLanguage, conversationLanguage: command.conversationLanguage, outputLanguage: command.outputLanguage, agent: command.agent, intent: command.intent, status: command.intent === 'clarify_language' ? 'needs_clarification' : command.requiresApproval ? 'waiting_approval' : 'completed', requiresApproval: command.requiresApproval, authorityGranted: false }
  if (command.intent === 'informational') {
    if (!userId || !projectId) throw voiceError('PROJECT_CONTEXT_REQUIRED', 'Authenticated project context is required')
    const getSummary = dependencies.getProjectSummary || (async () => {
      const { rows } = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM marketing_campaigns WHERE user_id=$1 AND project_id=$2) AS campaigns,
        (SELECT COUNT(*)::int FROM marketing_artifacts WHERE user_id=$1 AND project_id=$2) AS artifacts,
        (SELECT COUNT(*)::int FROM sosy_delegations WHERE user_id=$1 AND project_id=$2 AND status NOT IN ('completed','failed')) AS active_sosy`, [userId, projectId])
      return rows[0] || { campaigns: 0, artifacts: 0, active_sosy: 0 }
    })
    const summary = await getSummary({ userId, projectId })
    return { ...base, projectSummary: summary, replyText: command.conversationLanguage === 'nb-NO' ? `Prosjektet har ${summary.campaigns} kampanjer, ${summary.artifacts} markedsføringsutkast og ${summary.active_sosy} aktive Sosy-oppgaver.` : `The project has ${summary.campaigns} campaigns, ${summary.artifacts} marketing drafts, and ${summary.active_sosy} active Sosy tasks.` }
  }
  if (command.intent === 'draft_creation') {
    if (!userId || !projectId) throw voiceError('PROJECT_CONTEXT_REQUIRED', 'Authenticated project context is required')
    const artifact = await (dependencies.saveArtifact || saveArtifact)({ userId, projectId, type: 'social', purpose: command.transcript, channel: null, content: { schemaVersion: 1, kind: 'tony-voice-draft', languages: { conversationLanguage: command.conversationLanguage, outputLanguage: command.outputLanguage }, text: command.transcript, status: 'draft' }, provider: 'deterministic-local', model: 'tony-voice-draft-v1', provenance: {} })
    return { ...base, artifact, status: 'waiting_approval', requiresApproval: true }
  }
  if (command.intent !== 'sosy_delegation') return base
  if (!userId || !projectId) throw voiceError('PROJECT_CONTEXT_REQUIRED', 'Authenticated project context is required')
  const delegation = createSosyDelegation({ userId, projectId, campaignId: input.campaignId || null, tonyPlanId: input.tonyPlanId || null, taskType: 'content.create', objective: command.transcript, channels: input.channels || ['instagram'], languages: { conversationLanguage: command.conversationLanguage, outputLanguage: command.outputLanguage } })
  const saveDelegation = dependencies.saveDelegation || saveSosyDelegation
  const updateDelegationFn = dependencies.updateDelegation || updateSosyDelegation
  const saveArtifactFn = dependencies.saveArtifact || saveArtifact
  const saved = await saveDelegation(delegation)
  const working = transitionSosyDelegation(saved, 'working')
  const claimed = await updateDelegationFn({ delegation: working, from: saved.status })
  if (!claimed) throw voiceError('DELEGATION_CONFLICT', 'Sosy delegation state changed', 409)
  const draft = buildSosyDraft(claimed)
  const requestedCount = /\b(?:five|fem|cinco)\b/i.test(command.transcript) ? 5 : 1
  if (requestedCount > 1 && Array.isArray(draft.content?.variants)) {
    draft.content.variants = draft.content.variants.flatMap(variant => Array.from({ length: requestedCount }, (_, index) => ({ ...variant, sequence: index + 1 })))
  }
  const artifact = await saveArtifactFn({ userId, projectId, campaignId: saved.campaignId, type: draft.artifactType, purpose: draft.purpose, channel: draft.channel, content: draft.content, provider: 'deterministic-local', model: 'sosy-voice-draft-v1', provenance: {} })
  const waiting = transitionSosyDelegation(claimed, 'waiting_approval', { resultArtifactId: artifact.id })
  const completedDelegation = await updateDelegationFn({ delegation: waiting, from: claimed.status })
  if (!completedDelegation) throw voiceError('DELEGATION_CONFLICT', 'Sosy delegation state changed', 409)
  return { ...base, delegation: completedDelegation, artifact, status: 'waiting_approval', requiresApproval: true, mock: true }
}
