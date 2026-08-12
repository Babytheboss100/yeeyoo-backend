import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactToPostDraft, enqueueArtifact } from '../src/marketing/artifactWorkflow.js'
import { createArtifactRecord } from '../src/marketing/artifacts.js'

const approved = {id:'a1',rootId:'a1',userId:'u1',projectId:'p1',artifactVersion:2,status:'approved',channel:'linkedin',content:{socialCopy:'Ship useful work.'}}

test('only approved artifacts can enter Planner or Queue', () => {
  assert.throws(()=>artifactToPostDraft({...approved,status:'draft'}),error=>error.code==='ARTIFACT_NOT_APPROVED')
  assert.equal(artifactToPostDraft(approved).status,'approved')
})

test('scheduled artifact maps to canonical scheduled post', () => {
  const post=artifactToPostDraft(approved,{scheduledAt:'2026-09-01T10:00:00Z'})
  assert.equal(post.status,'scheduled'); assert.equal(post.platform,'linkedin'); assert.equal(post.artifactVersion,2)
})

test('artifact record initializes an immutable version root', () => {
  const artifact=createArtifactRecord({userId:'u1',projectId:'p1',type:'copy',purpose:'launch',content:{headline:'Hi'}},{id:'a1'})
  assert.equal(artifact.rootId,'a1'); assert.equal(artifact.parentId,null); assert.equal(artifact.artifactVersion,1)
})

test('enqueue uses a tenant-and-version idempotency conflict key', async () => {
  const calls=[]; const db={query:async(sql,params)=>{calls.push({sql,params});return{rows:[{id:'post1'}]}}}
  const first=await enqueueArtifact({artifact:approved,db}); const second=await enqueueArtifact({artifact:approved,db})
  assert.equal(first.id,second.id); assert.match(calls[0].sql,/ON CONFLICT \(user_id,project_id,artifact_id,artifact_version\)/)
  assert.deepEqual(calls[0].params.slice(-2),['a1',2])
})

test('different approved versions produce distinct enqueue identities', () => {
  assert.notEqual(artifactToPostDraft(approved).artifactVersion,artifactToPostDraft({...approved,id:'a2',artifactVersion:3}).artifactVersion)
})
