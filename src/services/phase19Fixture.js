export const PHASE19=Object.freeze({
  userId:'00000000-0000-4000-8000-000000000001',projectId:'10000000-0000-4000-8000-000000000001',
  campaignId:'31000000-0000-4000-8000-000000000001',artifactRootId:'32000000-0000-4000-8000-000000000001',
  artifactV1Id:'32000000-0000-4000-8000-000000000001',artifactV2Id:'32000000-0000-4000-8000-000000000002',
})
const EXPECTED='yeeyoo_phase13_test'
export async function assertPhase19Database(client){const{rows}=await client.query('SELECT current_database() AS name');if(rows[0]?.name!==EXPECTED)throw new Error('Phase19 database identity rejected');return rows[0].name}
export async function seedPhase19Fixture(client){await assertPhase19Database(client);const f=PHASE19;await client.query('BEGIN');try{
  await client.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,objective,status,context) VALUES($1,$2,$3,'Phase19 Loop','Deterministic integration proof','planned',$4)
    ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,project_id=EXCLUDED.project_id,name=EXCLUDED.name,objective=EXCLUDED.objective,status='planned',context=EXCLUDED.context`,[f.campaignId,f.userId,f.projectId,JSON.stringify({audience:'Test audience',offer:'Test offer',channels:['linkedin']})])
  await client.query('DELETE FROM marketing_approval_decisions WHERE user_id=$1 AND project_id=$2 AND artifact_id IN($3,$4)',[f.userId,f.projectId,f.artifactV1Id,f.artifactV2Id])
  await client.query('DELETE FROM posts WHERE user_id=$1 AND project_id=$2 AND artifact_id IN($3,$4)',[f.userId,f.projectId,f.artifactV1Id,f.artifactV2Id])
  await client.query('DELETE FROM marketing_artifacts WHERE user_id=$1 AND project_id=$2 AND root_id=$3',[f.userId,f.projectId,f.artifactRootId])
  const provenance=JSON.stringify({marketingProfileVersion:2,competitorIds:[],jobId:null,generatedAt:'2026-08-13T00:00:00.000Z'})
  for(const [id,parent,version,headline] of [[f.artifactV1Id,null,1,'Phase19 draft'],[f.artifactV2Id,f.artifactV1Id,2,'Phase19 approved copy']])await client.query(`INSERT INTO marketing_artifacts(id,root_id,parent_id,user_id,project_id,campaign_id,type,schema_version,artifact_version,status,purpose,channel,content,provenance,provider,model)
    VALUES($1,$2,$3,$4,$5,$6,'copy',1,$7,$8,'Phase19 loop','linkedin',$9,$10,'deterministic-local','phase19-fixture')`,[id,f.artifactRootId,parent,f.userId,f.projectId,f.campaignId,version,version===2?'approved':'archived',JSON.stringify({headline,socialCopy:`${headline}. Learn more.`}),provenance])
  await client.query(`INSERT INTO marketing_approval_decisions(id,user_id,project_id,campaign_id,artifact_id,artifact_version,decision,comment)
    VALUES('33000000-0000-4000-8000-000000000001',$1,$2,$3,$4,2,'approved','Deterministic Phase19 approval') ON CONFLICT DO NOTHING`,[f.userId,f.projectId,f.campaignId,f.artifactV2Id])
  await client.query('COMMIT');return f
}catch(error){await client.query('ROLLBACK');throw error}}

