import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecialistJobHandler } from '../src/marketing/specialistJobHandler.js'
import { createOfflineMarketingWorker } from '../src/jobs/offlineMarketingWorker.js'

function specialistDb(){const calls=[];return{calls,async query(sql,params){calls.push({sql,params});if(sql.includes('project_marketing_profiles'))return{rows:[{profile:{version:2,objectives:['Leads'],audiences:['Founders'],offers:['Audit'],channels:['linkedin']}}]};if(sql.includes('FROM competitors'))return{rows:[]};if(sql.includes('FROM channel_connections'))return{rows:[{provider:'linkedin',status:'connected'}]};if(sql.includes('INSERT INTO marketing_artifacts'))return{rows:[{id:params[0],root_id:params[1],parent_id:params[2],user_id:params[3],project_id:params[4],campaign_id:params[5],type:params[6],schema_version:params[7],artifact_version:params[8],status:'draft',purpose:params[9],channel:params[10],content:JSON.parse(params[11]),provenance:JSON.parse(params[12]),provider:params[13],model:params[14],checksum_version:params[15],content_checksum:params[16],output_checksum:params[17]}]};throw new Error(sql)}}}

// env:{} pins the no-credential case; a real key on the machine must not
// turn this contract test into a live provider call.
test('social/email/ads handlers are offline, scoped and draft-only',async()=>{for(const kind of ['social','email','ads']){const db=specialistDb();const result=await createSpecialistJobHandler({kind,db,env:{}})({id:`j-${kind}`,userId:'u1',projectId:'p1',input:{}});assert.equal(result.usage.providerCalls,0);assert.equal(result.usage.mode,'offline-draft');assert.equal(result.artifacts[0].status,'draft');const write=db.calls.find(call=>call.sql.includes('INSERT INTO marketing_artifacts'));assert.ok(write);assert.ok(write.params.includes('u1'));assert.ok(write.params.includes('p1'))}})

test('pipeline rejects unsupported execution kind',()=>assert.throws(()=>createSpecialistJobHandler({kind:'publish'}),/Unsupported offline/))

test('offline worker registers bounded marketing kinds without starting work',()=>{const db={query:async()=>({rows:[]})};const worker=createOfflineMarketingWorker({workerId:'w1',db,crawler:async()=>{throw new Error('must not execute')}});assert.equal(typeof worker.runOnce,'function');assert.equal(typeof worker.recover,'function')})

