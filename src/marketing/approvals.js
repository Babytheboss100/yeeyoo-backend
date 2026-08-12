import crypto from 'node:crypto'
export const APPROVAL_DECISIONS = Object.freeze(['approved','rejected','changes_requested'])
export function createApprovalDecision(input,{id=crypto.randomUUID(),now=new Date().toISOString()}={}) {
  if(!input.userId||!input.projectId||!input.artifactId||!Number.isInteger(input.artifactVersion)||input.artifactVersion<1) throw new Error('approval scope and artifact version are required')
  if(!APPROVAL_DECISIONS.includes(input.decision)) throw new Error('Unsupported approval decision')
  return {id,userId:input.userId,projectId:input.projectId,campaignId:input.campaignId||null,artifactId:input.artifactId,artifactVersion:input.artifactVersion,decision:input.decision,comment:String(input.comment||'').trim()||null,groupId:input.groupId||null,decidedAt:now}
}
export function assertApprovalMatchesArtifact(decision,artifact){
  if(!artifact||decision.userId!==artifact.userId||decision.projectId!==artifact.projectId||decision.artifactId!==artifact.id||decision.artifactVersion!==artifact.artifactVersion){const e=new Error('Approval does not match current scoped artifact version');e.code='STALE_OR_FORGED_APPROVAL';throw e}
  return true
}
