import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecialistJobHandler } from '../src/marketing/specialistJobHandler.js'
import { createOfflineMarketingWorker } from '../src/jobs/offlineMarketingWorker.js'

function specialistDb(){const calls=[];return{calls,async query(sql,params){calls.push({sql,params});if(sql.includes('project_marketing_profiles'))return{rows:[{profile:{version:2,objectives:['Leads'],audiences:['Founders'],offers:['Audit'],channels:['linkedin']}}]};if(sql.includes('FROM competitors'))return{rows:[]};if(sql.includes('FROM channel_connections'))return{rows:[{provider:'linkedin',status:'connected'}]};if(sql.includes('INSERT INTO marketing_artifacts'))return{rows:[{id:'a1',root_id:'a1',user_id:'u1',project_id:'p1',type:'social',status:'draft',content:{}}]};throw new Error(sql)}}}

test('social/email/ads handlers are offline, scoped and draft-only',async()=>{for(const kind of ['social','email','ads']){const db=specialistDb();const result=await createSpecialistJobHandler({kind,db})({id:`j-${kind}`,userId:'u1',projectId:'p1',input:{}});assert.equal(result.usage.providerCalls,0);assert.equal(result.usage.mode,'offline-draft');assert.equal(result.artifacts[0].status,'draft');const write=db.calls.find(call=>call.sql.includes('INSERT INTO marketing_artifacts'));assert.ok(write);assert.ok(write.params.includes('u1'));assert.ok(write.params.includes('p1'))}})

test('pipeline rejects unsupported execution kind',()=>assert.throws(()=>createSpecialistJobHandler({kind:'publish'}),/Unsupported offline/))

test('offline worker registers bounded marketing kinds without starting work',()=>{const db={query:async()=>({rows:[]})};const worker=createOfflineMarketingWorker({workerId:'w1',db,crawler:async()=>{throw new Error('must not execute')}});assert.equal(typeof worker.runOnce,'function');assert.equal(typeof worker.recover,'function')})

