import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dotenv from 'dotenv'
import pg from 'pg'
import {PHASE19} from '../src/services/phase19Fixture.js'
import {publishPost} from '../src/publishing/service.js'
dotenv.config({override:true})

test('mock execution persists one logical Activity and observed Performance Event',async t=>{
  const db=new pg.Pool({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},max:3,connectionTimeoutMillis:10000});t.after(()=>db.end())
  const identity=await db.query('SELECT current_database() name');assert.equal(identity.rows[0]?.name,'yeeyoo_phase13_test')
  const suffix=crypto.randomUUID(),campaignId=`p25cd-c-${suffix}`,artifactId=`p25cd-a-${suffix}`,postId=crypto.randomUUID(),decisionId=crypto.randomUUID(),key=`p25cd-${suffix}`
  try{
    await db.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,status,context) VALUES($1,$2,$3,'P25CD','active','{}')`,[campaignId,PHASE19.userId,PHASE19.projectId])
    await db.query(`INSERT INTO marketing_artifacts(id,root_id,user_id,project_id,campaign_id,type,purpose,channel,content,provenance,provider,model,status,artifact_version) VALUES($1,$1,$2,$3,$4,'copy','P25CD','linkedin','{"socialCopy":"safe"}','{}','mock','mock','approved',1)`,[artifactId,PHASE19.userId,PHASE19.projectId,campaignId])
    await db.query(`INSERT INTO marketing_approval_decisions(id,user_id,project_id,campaign_id,artifact_id,artifact_version,decision) VALUES($1,$2,$3,$4,$5,1,'approved')`,[decisionId,PHASE19.userId,PHASE19.projectId,campaignId,artifactId])
    await db.query(`INSERT INTO posts(id,user_id,project_id,campaign_id,platform,content,status,artifact_id,artifact_version) VALUES($1,$2,$3,$4,'linkedin','safe','approved',$5,1)`,[postId,PHASE19.userId,PHASE19.projectId,campaignId,artifactId])
    const args={userId:PHASE19.userId,postId,projectId:PHASE19.projectId,campaignId,artifactId,artifactVersion:1,idempotencyKey:key,adapter:{id:'mock-local',publish:async()=>({provider:'mock-local',externalId:key,status:'published'})},db}
    const first=await publishPost(args),second=await publishPost(args);assert.equal(first.body.idempotent,false);assert.equal(second.body.idempotent,true)
    const activity=await db.query(`SELECT count(*)::int count FROM project_activity WHERE user_id=$1 AND project_id=$2 AND subject_id=$3`,[PHASE19.userId,PHASE19.projectId,postId])
    const performance=await db.query(`SELECT count(*)::int count FROM marketing_performance_events WHERE user_id=$1 AND project_id=$2 AND campaign_id=$3 AND artifact_id=$4`,[PHASE19.userId,PHASE19.projectId,campaignId,artifactId])
    assert.equal(activity.rows[0].count,1);assert.equal(performance.rows[0].count,1)
  }finally{
    await db.query('DELETE FROM streak_events WHERE user_id=$1 AND event_key=$2',[PHASE19.userId,`publish:${postId}`]).catch(()=>{})
    await db.query('DELETE FROM marketing_performance_events WHERE campaign_id=$1',[campaignId]).catch(()=>{});await db.query('DELETE FROM project_activity WHERE subject_id=$1',[postId]).catch(()=>{})
    await db.query('DELETE FROM publish_attempts WHERE post_id=$1',[postId]).catch(()=>{});await db.query('DELETE FROM posts WHERE id=$1',[postId]).catch(()=>{})
    await db.query('DELETE FROM marketing_approval_decisions WHERE id=$1',[decisionId]).catch(()=>{});await db.query('DELETE FROM marketing_artifacts WHERE id=$1',[artifactId]).catch(()=>{});await db.query('DELETE FROM marketing_campaigns WHERE id=$1',[campaignId]).catch(()=>{})
  }
})
