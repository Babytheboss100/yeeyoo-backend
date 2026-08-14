import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {publishPost} from '../src/publishing/service.js'

const scope={userId:'u',postId:'post',projectId:'project',campaignId:'campaign',artifactId:'artifact',artifactVersion:2,idempotencyKey:'browser-key'}
function database({status='approved',approved=true,previous=null}={}){
  const state={queries:[],activity:0,performance:0}
  const post={id:'post',user_id:'u',project_id:'project',campaign_id:'campaign',artifact_id:'artifact',artifact_version:2,status,content:'safe',approval_current:approved}
  const client={async query(sql,params=[]){state.queries.push({sql,params});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]}
    if(sql.includes('FROM posts p'))return{rows:[post]}
    if(sql.includes('FROM publish_attempts'))return{rows:previous?[previous]:[]}
    if(sql.includes('INSERT INTO publish_attempts')||sql.includes('UPDATE publish_attempts'))return{rows:[]}
    if(sql.includes("UPDATE posts SET status='published'"))return{rows:[{...post,status:'published'}]}
    if(sql.includes("UPDATE posts SET status='publish_failed'"))return{rows:[]}
    if(sql.includes('INSERT INTO project_activity')){state.activity++;return{rows:[{id:'activity'}]}}
    if(sql.includes('INSERT INTO marketing_performance_events')){state.performance++;return{rows:[{id:'event'}]}}
    throw new Error(`Unexpected SQL: ${sql}`)},release(){}}
  return{state,connect:async()=>client,query:async()=>({rows:[{current_count:1,longest_count:1,last_activity_date:'2026-08-14'}]})}
}

test('explicit mock execution is scope-bound, idempotent and records observed evidence',async()=>{
  const db=database(),adapter={id:'mock-local',publish:async({idempotencyKey})=>({provider:'mock-local',externalId:idempotencyKey,status:'published'})}
  const result=await publishPost({...scope,adapter,db,now:new Date('2026-08-14T00:00:00Z')})
  assert.equal(result.status,200);assert.equal(db.state.activity,1);assert.equal(db.state.performance,1)
  assert.ok(db.state.queries.some(q=>q.params.includes('u:post:browser-key')))
})

test('changed scope and missing current approval fail closed before adapter execution',async()=>{
  let calls=0;const adapter={id:'mock-local',publish:async()=>{calls++}}
  assert.equal((await publishPost({...scope,artifactVersion:3,adapter,db:database()})).body.code,'EXECUTION_SCOPE_MISMATCH')
  assert.equal((await publishPost({...scope,adapter,db:database({approved:false})})).body.code,'APPROVAL_REQUIRED')
  assert.equal(calls,0)
})

test('retry is bounded and route accepts mock-local only',async()=>{
  const adapter={id:'mock-local',publish:async()=>{throw new Error('offline failure')}}
  const failed=await publishPost({...scope,adapter,db:database()});assert.equal(failed.body.retryable,true)
  const limited=await publishPost({...scope,adapter,db:database({status:'publish_failed',previous:{status:'failed',provider_result:{attempts:2}}})})
  assert.equal(limited.body.code,'RETRY_LIMIT_REACHED')
  const route=fs.readFileSync(new URL('../src/routes/content.js',import.meta.url),'utf8')
  assert.match(route,/PUBLISH_ADAPTER !== 'mock-local'/);assert.match(route,/Idempotency-Key/)
  assert.match(route,/catch \{[\s\S]*MOCK_EXECUTION_ERROR/)
})
