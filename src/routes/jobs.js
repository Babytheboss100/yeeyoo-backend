import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { getOwnedJob } from '../jobs/jobStore.js'
import { retryJob } from '../jobs/jobRunner.js'
import { cancelOwnedJob, listOwnedJobs } from '../jobs/workerStore.js'

const r=Router();r.use(auth)
const publicJob=job=>{const {input,leaseOwner,...safe}=job||{};return safe}
const fail=(res,error)=>{if(!sendProjectError(res,error))res.status(error.code==='RETRY_LIMIT'?409:400).json({error:error.message,code:error.code||'INVALID_JOB_REQUEST'})}
r.get('/:projectId',async(req,res)=>{try{await requireProject(req,req.params.projectId);const allowed=new Set(['queued','running','succeeded','failed','cancelled']);const status=req.query.status||null;if(status&&!allowed.has(status))return res.status(400).json({error:'Invalid status'});const jobs=await listOwnedJobs({userId:req.user.id,projectId:req.params.projectId,status,kind:req.query.kind||null,limit:req.query.limit});res.json({jobs:jobs.map(publicJob)})}catch(error){fail(res,error)}})
r.get('/:projectId/:id',async(req,res)=>{try{await requireProject(req,req.params.projectId);const job=await getOwnedJob({id:req.params.id,userId:req.user.id,projectId:req.params.projectId});if(!job)return res.status(404).json({error:'Job not found'});res.json({job:publicJob(job)})}catch(error){fail(res,error)}})
r.post('/:projectId/:id/retry',async(req,res)=>{try{await requireProject(req,req.params.projectId);const job=await getOwnedJob({id:req.params.id,userId:req.user.id,projectId:req.params.projectId});if(!job)return res.status(404).json({error:'Job not found'});res.json({job:publicJob(await retryJob({job}))})}catch(error){fail(res,error)}})
r.post('/:projectId/:id/cancel',async(req,res)=>{try{await requireProject(req,req.params.projectId);const job=await cancelOwnedJob({id:req.params.id,userId:req.user.id,projectId:req.params.projectId});if(!job)return res.status(409).json({error:'Job is terminal or unavailable'});res.json({job:publicJob(job)})}catch(error){fail(res,error)}})
export default r
