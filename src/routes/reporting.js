import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { requireProject, sendProjectError } from '../middleware/project.js'
import { pool } from '../db.js'
import { assertObservedEvents, buildObservedLearning, buildReportingSummary } from '../marketing/learningLoop.js'
const r=Router();r.use(auth)
r.get('/:projectId',async(req,res)=>{try{const projectId=req.params.projectId;await requireProject(req,projectId);const values=[req.user.id,projectId];let where='user_id=$1 AND project_id=$2';if(req.query.campaignId){values.push(req.query.campaignId);where+=` AND campaign_id=$${values.length}`}if(req.query.from){values.push(req.query.from);where+=` AND occurred_at >= $${values.length}`}if(req.query.to){values.push(req.query.to);where+=` AND occurred_at <= $${values.length}`}const{rows}=await pool.query(`SELECT id,campaign_id,artifact_id,kind,value,unit,occurred_at,source,metadata FROM marketing_performance_events WHERE ${where} ORDER BY occurred_at DESC LIMIT 1000`,values);assertObservedEvents(rows);res.json({projectId,campaignId:req.query.campaignId||null,observedEvents:rows,summary:buildReportingSummary(rows),learning:buildObservedLearning(rows),missingMetricsAreOmitted:true})}catch(error){if(!sendProjectError(res,error))res.status(500).json({error:'Reporting could not be loaded'})}})
export default r
