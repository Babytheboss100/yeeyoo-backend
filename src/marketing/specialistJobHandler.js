import { pool } from '../db.js'
import { getMarketingProfile } from './profileStore.js'
import { saveArtifact } from './artifacts.js'
import { specialistGenerators } from './specialistAgents.js'

const ALLOWED=new Set(['social','email','ads'])
export function createSpecialistJobHandler({kind,db=pool}={}){
  if(!ALLOWED.has(kind))throw new TypeError('Unsupported offline specialist pipeline')
  return async job=>{
    const generate=specialistGenerators[kind]
    const [profile,competitors,connections]=await Promise.all([
      getMarketingProfile({userId:job.userId,projectId:job.projectId,db}),
      db.query(`SELECT id,evidence,intelligence FROM competitors WHERE user_id=$1 AND project_id=$2 AND status='analyzed'`,[job.userId,job.projectId]),
      db.query(`SELECT provider,status FROM channel_connections WHERE user_id=$1 AND project_id=$2`,[job.userId,job.projectId]),
    ])
    const context={profile,competitors:competitors.rows.map(row=>({id:row.id,evidenceIds:(row.evidence||[]).map(item=>item.id||item.url).filter(Boolean),observations:row.intelligence?.seoObservations||[]})),connections:connections.rows}
    const content=generate(job.input||{},context)
    const artifact=await saveArtifact({userId:job.userId,projectId:job.projectId,campaignId:job.input?.campaignId,type:kind,purpose:job.input?.purpose||content.objective,channel:job.input?.channel||null,content,provenance:{marketingProfileVersion:profile.version,competitorIds:content.provenance.competitorIds,jobId:job.id},provider:'deterministic-local',model:`${kind}-fixture-v1`},db)
    return {artifacts:[{id:artifact.id,type:kind,status:artifact.status}],usage:{providerCalls:0,mode:'offline-draft'}}
  }
}
