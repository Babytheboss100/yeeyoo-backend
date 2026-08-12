import crypto from 'node:crypto'
import { Router } from 'express'
import { auth } from '../middleware/auth.js'; import { requireProject,sendProjectError } from '../middleware/project.js'
import { listArtifacts,saveArtifact,transitionArtifact } from '../marketing/artifacts.js'
import { generateCopy } from '../marketing/copyAgent.js'; import { getMarketingProfile } from '../marketing/profileStore.js'; import { createJob } from '../jobs/jobStore.js'
const r=Router(); r.use(auth)
const fail=(res,e)=>{if(!sendProjectError(res,e)) res.status(e.code==='INVALID_TRANSITION'?409:400).json({error:e.message,code:e.code||'INVALID_REQUEST'})}
r.get('/:projectId',async(req,res)=>{try{await requireProject(req,req.params.projectId);res.json({artifacts:await listArtifacts({userId:req.user.id,projectId:req.params.projectId,type:req.query.type})})}catch(e){fail(res,e)}})
r.post('/:projectId/copy',async(req,res)=>{try{const projectId=req.params.projectId;await requireProject(req,projectId);const profile=await getMarketingProfile({userId:req.user.id,projectId});const job=await createJob({userId:req.user.id,projectId,kind:'marketing.copy',provider:'deterministic-local',model:'copy-fixture-v1',idempotencyKey:req.get('Idempotency-Key')||`copy:${crypto.randomUUID()}`,input:req.body});const content=generateCopy(req.body,{profile});const artifact=await saveArtifact({userId:req.user.id,projectId,type:'copy',purpose:req.body.purpose||req.body.objective,channel:req.body.channel,content,provenance:{marketingProfileVersion:profile.version,competitorIds:req.body.competitorIds,jobId:job.id}});res.status(201).json({artifact,jobId:job.id,mock:true})}catch(e){fail(res,e)}})
r.patch('/:projectId/:id/status',async(req,res)=>{try{await requireProject(req,req.params.projectId);const artifact=await transitionArtifact({id:req.params.id,userId:req.user.id,projectId:req.params.projectId,to:req.body.status});if(!artifact)return res.status(404).json({error:'Artifact not found'});res.json(artifact)}catch(e){fail(res,e)}})
export default r
