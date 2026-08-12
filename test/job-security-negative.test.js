import test from 'node:test'
import assert from 'node:assert/strict'
import { cancelOwnedJob, heartbeatJob } from '../src/jobs/workerStore.js'
import { createWorker } from '../src/jobs/worker.js'

test('cross-project cancellation requires all ownership dimensions',async()=>{let params;const db={query:async(_sql,p)=>{params=p;return{rows:[]}}};assert.equal(await cancelOwnedJob({id:'j',userId:'attacker',projectId:'victim-project',db}),null);assert.deepEqual(params,['j','attacker','victim-project'])})
test('worker cannot heartbeat another worker lease',async()=>{let sql;const db={query:async(s)=>{sql=s;return{rowCount:0}}};assert.equal(await heartbeatJob({id:'j',workerId:'attacker-worker',db}),false);assert.match(sql,/lease_owner=\$2/)})
test('handler failure cannot leak secret details through durable error',async()=>{const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});if(sql.includes('WITH candidate'))return{rows:[{id:'j',user_id:'u',project_id:'p',kind:'social',status:'running',input:{},lease_owner:'w',retry_count:0,max_retries:0}]};if(sql.includes('UPDATE ai_jobs SET\n    status=CASE'))return{rows:[{id:'j',status:'failed'}]};throw new Error(sql)}};await createWorker({workerId:'w',handlers:{social:async()=>{throw new Error('api-key-SECRET')}},db}).runOnce();const failure=calls.at(-1);assert.doesNotMatch(failure.params[3],/SECRET/);assert.match(failure.params[3],/Worker failed/)})

