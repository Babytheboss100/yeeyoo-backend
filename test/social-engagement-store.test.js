import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestInteraction } from '../src/services/socialEngagementStore.js'

test('ingest binds every write to tenant/project and deduplicates provider replay',async()=>{
  const calls=[]; const db={async query(sql,values){calls.push({sql,values});if(sql.includes('INSERT INTO social_engagement_interactions'))return{rows:[{id:'i1',classification:{lead:true}}]};return{rows:[]}}}
  await ingestInteraction({userId:'tenant-a',projectId:'project-a',input:{provider:'meta',providerAccountId:'page-1',providerInteractionId:'comment-1',kind:'comment',body:'Need pricing',occurredAt:new Date(Date.now()-1000).toISOString()},db})
  assert.match(calls[0].sql,/ON CONFLICT\(user_id,project_id,provider,provider_account_id,provider_interaction_id\)/)
  assert.deepEqual(calls[0].values.slice(1,3),['tenant-a','project-a'])
  assert.deepEqual(calls[1].values.slice(1,4),['tenant-a','project-a','i1'])
})
