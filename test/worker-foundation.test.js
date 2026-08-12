import test from 'node:test'
import assert from 'node:assert/strict'
import { claimNextJob, completeClaimedJob, failClaimedJob, recoverExpiredJobs, cancelOwnedJob } from '../src/jobs/workerStore.js'
import { createWorker } from '../src/jobs/worker.js'

test('worker claim uses SKIP LOCKED and exclusive lease owner', async () => {
  let call
  const db={query:async(sql,params)=>{call={sql,params};return{rows:[{id:'j1',user_id:'u1',project_id:'p1',kind:'copy',status:'running',lease_owner:'w1'}]}}}
  const job=await claimNextJob({workerId:'w1',kinds:['copy'],db})
  assert.match(call.sql,/FOR UPDATE SKIP LOCKED/); assert.match(call.sql,/lease_owner=\$2/); assert.equal(job.leaseOwner,'w1')
})

test('completion and cancellation are lease/project scoped', async () => {
  const calls=[]; const db={query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}}}
  await completeClaimedJob({id:'j',workerId:'w',db}); await cancelOwnedJob({id:'j',userId:'u',projectId:'p',db})
  assert.match(calls[0].sql,/lease_owner=\$2/); assert.match(calls[1].sql,/user_id=\$2 AND project_id=\$3/)
})

test('retry is bounded and expired leases are recoverable', async () => {
  const calls=[]; const db={query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}}}
  await failClaimedJob({id:'j',workerId:'w',error:new Error('secret detail'),db}); await recoverExpiredJobs({db})
  assert.match(calls[0].sql,/retry_count<max_retries/); assert.doesNotMatch(calls[0].params[3],/secret detail/)
  assert.match(calls[1].sql,/lease_expires_at<NOW/)
})

test('unified worker dispatches one registered kind', async () => {
  let count=0
  const db={query:async(sql)=>{if(sql.includes('WITH candidate')) return {rows:[{id:'j',user_id:'u',project_id:'p',kind:'copy',status:'running',input:{},lease_owner:'w'}]}; if(sql.includes("status='succeeded'")) return {rows:[{id:'j',status:'succeeded'}]}; throw new Error(sql)}}
  const worker=createWorker({workerId:'w',handlers:{copy:async()=>{count++;return{artifacts:[{id:'a'}]}}},db})
  const result=await worker.runOnce(); assert.equal(count,1); assert.equal(result.job.status,'succeeded')
})

