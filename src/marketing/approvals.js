import crypto from 'node:crypto'
import { verifyArtifactChecksums } from './artifacts.js'
import { assertRenderApproval, createRenderApprovalBinding } from '../mediaEngine/composer/approvalBinding.js'

export const APPROVAL_DECISIONS = Object.freeze(['approved','rejected','changes_requested'])
const SHA256_RE=/^[a-f0-9]{64}$/
export function createApprovalDecision(input,{id=crypto.randomUUID(),now=new Date().toISOString()}={}){
  if(!input.userId||!input.projectId||!input.artifactId||!Number.isInteger(input.artifactVersion)||input.artifactVersion<1)throw new Error('approval scope and artifact version are required')
  if(!APPROVAL_DECISIONS.includes(input.decision))throw new Error('Unsupported approval decision')
  if(!input.checksumVersion||!SHA256_RE.test(input.contentChecksum)||(input.outputChecksum!=null&&!SHA256_RE.test(input.outputChecksum)))throw Object.assign(new Error('approval checksums are required'),{code:'ARTIFACT_CHECKSUM_INVALID'})
  const decision={id,userId:input.userId,projectId:input.projectId,campaignId:input.campaignId||null,artifactId:input.artifactId,artifactVersion:input.artifactVersion,checksumVersion:input.checksumVersion,contentChecksum:input.contentChecksum,outputChecksum:input.outputChecksum||null,decision:input.decision,comment:String(input.comment||'').trim()||null,groupId:input.groupId||null,decidedAt:now,revokedAt:null,revocationReason:null}
  if(input.artifact)assertApprovalMatchesArtifact(decision,input.artifact)
  return decision
}
export function assertApprovalMatchesArtifact(decision,artifact){
  verifyArtifactChecksums(artifact)
  if(!decision||decision.revokedAt||decision.userId!==artifact.userId||decision.projectId!==artifact.projectId||decision.artifactId!==artifact.id||decision.artifactVersion!==artifact.artifactVersion||decision.checksumVersion!==artifact.checksumVersion||decision.contentChecksum!==artifact.contentChecksum||decision.outputChecksum!==artifact.outputChecksum){const e=new Error('Approval does not match current immutable artifact');e.code=decision?.revokedAt?'APPROVAL_REVOKED':'STALE_OR_FORGED_APPROVAL';throw e}
  const media=artifact.content?.media
  if(media)assertRenderApproval(createRenderApprovalBinding({userId:decision.userId,projectId:decision.projectId,artifactId:decision.artifactId,artifactVersion:decision.artifactVersion,outputSha256:decision.outputChecksum,composerProjectSha256:media.composerProjectSha256},{id:decision.id,now:decision.decidedAt}),artifact)
  return true
}
