import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { draftReply, getEngagementOverview, ingestInteraction } from '../services/socialEngagementStore.js'

const r=Router(); r.use(auth)
const fail=(res,error)=>{if(sendProjectError(res,error))return; if(error.code==='INVALID_ENGAGEMENT_INPUT')return res.status(400).json({error:error.message,code:error.code}); res.status(500).json({error:'Social engagement request failed'})}
r.get('/:projectId',async(req,res)=>{try{await requireProject(req,req.params.projectId);res.json(await getEngagementOverview({userId:req.user.id,projectId:req.params.projectId,date:req.query.date}))}catch(error){fail(res,error)}})
r.post('/:projectId/interactions',async(req,res)=>{try{await requireProject(req,req.params.projectId);const interaction=await ingestInteraction({userId:req.user.id,projectId:req.params.projectId,input:req.body});res.status(201).json({interaction,providerActionTaken:false})}catch(error){fail(res,error)}})
r.post('/:projectId/interactions/:interactionId/reply-drafts',async(req,res)=>{try{await requireProject(req,req.params.projectId);const key=req.get('Idempotency-Key');if(!key||key.length>200)return res.status(400).json({error:'Valid Idempotency-Key is required'});const draft=await draftReply({userId:req.user.id,projectId:req.params.projectId,interactionId:req.params.interactionId,idempotencyKey:key,brandName:req.body?.brandName});if(!draft)return res.status(404).json({error:'Interaction not found'});res.status(201).json({draft,providerActionTaken:false,approvalRequired:true})}catch(error){fail(res,error)}})
export default r
