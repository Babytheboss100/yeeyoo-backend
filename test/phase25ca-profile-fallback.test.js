import test from 'node:test'
import assert from 'node:assert/strict'
import { getMarketingProfile } from '../src/marketing/profileStore.js'

test('legacy business schema without project_id fails closed to an empty project profile',async()=>{
  const calls=[]
  const db={query:async(sql,params)=>{
    calls.push({sql,params})
    if(sql.includes('project_marketing_profiles'))return{rows:[]}
    const error=Object.assign(new Error('missing legacy column'),{code:'42703'})
    throw error
  }}
  const profile=await getMarketingProfile({userId:'user-a',projectId:'project-a',db})
  assert.equal(profile.projectId,'project-a')
  assert.equal(profile.brand.summary,'')
  assert.equal(calls.length,2)
  assert.deepEqual(calls[1].params,['project-a','user-a'])
})

test('unexpected profile storage failures remain errors',async()=>{
  const db={query:async()=>{throw Object.assign(new Error('offline'),{code:'ECONNRESET'})}}
  await assert.rejects(()=>getMarketingProfile({userId:'u',projectId:'p',db}),/offline/)
})
