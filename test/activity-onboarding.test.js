import test from 'node:test'
import assert from 'node:assert/strict'
import { listProjectActivity, recordProjectActivity } from '../src/lib/projectActivity.js'
import { buildOnboardingStatus } from '../src/marketing/onboardingStatus.js'

test('activity writes and reads remain project scoped and deduplicated', async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}}}
  await recordProjectActivity({userId:'u',projectId:'p',eventType:'job_failed',summary:'Job failed',dedupeKey:'job:j:failed',db})
  await listProjectActivity({userId:'u',projectId:'p',limit:999,db})
  assert.match(calls[0].sql,/ON CONFLICT\(user_id,project_id,dedupe_key\)/)
  assert.deepEqual(calls[1].params.slice(0,2),['u','p']);assert.equal(calls[1].params[3],100)
})

test('onboarding never claims unverified external work completed',()=>{
  const status=buildOnboardingStatus({project:{id:'p'},profile:{version:2},brand:{},competitors:[{status:'queued'}],connections:[{status:'revoked'}]})
  assert.equal(status.requiredComplete,true);assert.equal(status.steps.competitors.status,'available');assert.equal(status.steps.connections.status,'available');assert.equal(status.steps.tony.status,'ready')
})

