import crypto from 'node:crypto'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'; import { requireProject,sendProjectError } from '../middleware/project.js'
import { createArtifactVersion,getArtifact,listArtifacts,saveArtifact,transitionArtifact } from '../marketing/artifacts.js'
import { enqueueArtifact } from '../marketing/artifactWorkflow.js'
import { generateCopy } from '../marketing/copyAgent.js'; import { getMarketingProfile } from '../marketing/profileStore.js'; import { createJob } from '../jobs/jobStore.js'
const r=Router(); r.use(auth)
const ARTIFACT_ERRORS=new Map([
  ['INVALID_TRANSITION',{status:409,message:'Artifact status transition is not allowed'}],
  ['ARTIFACT_NOT_APPROVED',{status:409,message:'Artifact must be approved before enqueue'}],
  ['EMPTY_ARTIFACT',{status:400,message:'Artifact content is required'}],
])
const fail=(res,e)=>{
  if(sendProjectError(res,e))return
  const known=ARTIFACT_ERRORS.get(e?.code)
  if(known)return res.status(known.status).json({error:known.message,code:e.code})
  console.error('Artifact operation failed',{code:e?.code||'UNKNOWN'})
  return res.status(500).json({error:'Artifact operation failed',code:'ARTIFACT_OPERATION_FAILED'})
}
r.get('/:projectId',async(req,res)=>{try{await requireProject(req,req.params.projectId);res.json({artifacts:await listArtifacts({userId:req.user.id,projectId:req.params.projectId,type:req.query.type})})}catch(e){fail(res,e)}})
r.post('/:projectId/copy',async(req,res)=>{try{const projectId=req.params.projectId;await requireProject(req,projectId);const profile=await getMarketingProfile({userId:req.user.id,projectId});const job=await createJob({userId:req.user.id,projectId,kind:'marketing.copy',provider:'deterministic-local',model:'copy-fixture-v1',idempotencyKey:req.get('Idempotency-Key')||`copy:${crypto.randomUUID()}`,input:req.body});const content=generateCopy(req.body,{profile});const artifact=await saveArtifact({userId:req.user.id,projectId,type:'copy',purpose:req.body.purpose||req.body.objective,channel:req.body.channel,content,provenance:{marketingProfileVersion:profile.version,competitorIds:req.body.competitorIds,jobId:job.id}});res.status(201).json({artifact,jobId:job.id,mock:true})}catch(e){fail(res,e)}})
r.patch('/:projectId/:id/status',async(req,res)=>{try{await requireProject(req,req.params.projectId);const artifact=await transitionArtifact({id:req.params.id,userId:req.user.id,projectId:req.params.projectId,to:req.body.status});if(!artifact)return res.status(404).json({error:'Artifact not found'});res.json(artifact)}catch(e){fail(res,e)}})
r.post('/:projectId/:id/versions',async(req,res)=>{try{await requireProject(req,req.params.projectId);const source=await getArtifact({id:req.params.id,userId:req.user.id,projectId:req.params.projectId});if(!source)return res.status(404).json({error:'Artifact not found'});const regenerationInput={objective:source.purpose,audience:'project audience',offer:source.content?.headline||source.purpose,channel:source.channel,...(req.body.input||{})};const content=req.body.regenerate?generateCopy(regenerationInput,{profile:await getMarketingProfile({userId:req.user.id,projectId:req.params.projectId})}):req.body.content;if(!content||typeof content!=='object')return res.status(400).json({error:'content is required'});const artifact=await createArtifactVersion({source,userId:req.user.id,projectId:req.params.projectId,content,provider:req.body.regenerate?'deterministic-local':'manual-edit',model:req.body.regenerate?'copy-fixture-v1':'human'});res.status(201).json({artifact})}catch(e){fail(res,e)}})
r.post('/:projectId/:id/enqueue',async(req,res)=>{try{await requireProject(req,req.params.projectId);const artifact=await getArtifact({id:req.params.id,userId:req.user.id,projectId:req.params.projectId});if(!artifact)return res.status(404).json({error:'Artifact not found'});const post=await enqueueArtifact({artifact,scheduledAt:req.body.scheduledAt||null});res.status(201).json({post})}catch(e){fail(res,e)}})
export default r
