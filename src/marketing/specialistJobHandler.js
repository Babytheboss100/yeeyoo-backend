import { pool } from '../db.js'
import { getMarketingProfile, loadBrandContext } from './profileStore.js'
import { saveArtifact } from './artifacts.js'
import { specialistGenerators } from './specialistAgents.js'
import { generateVariantCopy } from './contentGenerator.js'

const ALLOWED=new Set(['social','email','ads'])
// generateCopy and env are injectable so a test can pin the offline contract
// instead of inheriting whatever credential the machine happens to carry.
export function createSpecialistJobHandler({kind,db=pool,env=process.env,generateCopy=generateVariantCopy}={}){
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
    // Only the social plan carries per-channel post copy; the email and ads
    // plans are structure rather than prose, so there is nothing to write there.
    let provider='deterministic-local',model=`${kind}-fixture-v1`,usage={providerCalls:0,mode:'offline-draft'}
    if(kind==='social'&&Array.isArray(content.draftCalendar)&&content.draftCalendar.length){
      const language=job.input?.language||'en'
      const variants=content.draftCalendar.map((entry,index)=>({channel:entry.channel,language,text:content.hooks?.[index]||content.hooks?.[0]||entry.theme}))
      const generated=await generateCopy({variants,objective:content.objective,languages:{outputLanguage:language},brand:await loadBrandContext({userId:job.userId,projectId:job.projectId,db}),sourceText:(content.contentPillars||[]).join('. ')||null,env})
      if(generated){
        content.draftCalendar=content.draftCalendar.map((entry,index)=>generated.variants[index]?.generated?{...entry,text:generated.variants[index].text}:entry)
        // Hooks become the opening line of the copy that was actually written,
        // so the plan cannot advertise a hook the post does not contain.
        const written=generated.variants.filter(variant=>variant.generated).map(variant=>String(variant.text).split(/\r?\n/)[0].trim()).filter(Boolean)
        if(written.length)content.hooks=written
        content.mode='live-draft'
        provider=generated.provider;model=generated.model;usage=generated.usage
      }
    }
    const artifact=await saveArtifact({userId:job.userId,projectId:job.projectId,campaignId:job.input?.campaignId,type:kind,purpose:job.input?.purpose||content.objective,channel:job.input?.channel||null,content,provenance:{marketingProfileVersion:profile.version,competitorIds:content.provenance.competitorIds,jobId:job.id},provider,model},db)
    return {artifacts:[{id:artifact.id,type:kind,status:artifact.status}],usage}
  }
}
