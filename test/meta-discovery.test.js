import test from 'node:test'
import assert from 'node:assert/strict'
import { capabilityState, metaDiscoveryCapabilities } from '../src/lib/channelConnections.js'
import { ChannelProviderError, createMockChannelProviderAdapter } from '../src/lib/channelProviderAdapters.js'
import { createChannelOAuthService } from '../src/lib/channelOAuthService.js'

const baseRow={id:'c1',user_id:'u1',project_id:'p1',provider:'meta',provider_account_id:'mock:meta:p1',status:'connected',scopes:['pages_show_list','instagram_basic'],capabilities:{}}
function dbFor(row={...baseRow}){return{row,calls:[],async query(sql,params){this.calls.push({sql,params})
  if(sql.includes('FROM channel_connections')&&sql.includes('id=$1'))return{rows:row&&params[0]===row.id&&params[1]===row.user_id&&params[2]===row.project_id?[row]:[]}
  if(sql.includes('UPDATE channel_connections SET status=$1')){Object.assign(row,{status:params[0],capabilities:JSON.parse(params[1]),last_error_code:params[2]});return{rows:[row]}}
  if(sql.includes("UPDATE channel_connections SET status='revoked'")){row.status='revoked';return{rows:[row]}}
  if(sql.includes('INSERT INTO channel_oauth_states'))return{rows:[]}
  throw new Error(`Unexpected SQL ${sql}`)
}}}

test('capability truth separates supported, authorized and ready',()=>{
  assert.deepEqual(capabilityState({supported:true}),{supported:true,authorized:false,ready:false,reason:'authorization_required'})
  const discovered=metaDiscoveryCapabilities({scopes:['pages_show_list','instagram_basic'],connected:true,pages:[{id:'page',instagramProfessionalAccount:{id:'ig'}}]})
  assert.equal(discovered.facebookPageDiscovery.ready,true);assert.equal(discovered.instagramProfessionalDiscovery.ready,true)
  assert.equal(metaDiscoveryCapabilities({scopes:[],connected:true,pages:[{id:'page'}]}).facebookPageDiscovery.authorized,false)
})

test('Meta mock discovery returns Pages and linked professional Instagram accounts without credentials',async()=>{
  const db=dbFor();const adapter=createMockChannelProviderAdapter('meta',{metaPages:[{id:'page-1',name:'Acme',instagramProfessionalAccount:{id:'ig-1',username:'acme'}}]})
  const result=await createChannelOAuthService({db,adapters:{meta:adapter}}).discoverMeta({id:'c1',userId:'u1',projectId:'p1'})
  assert.equal(result.pages[0].instagramProfessionalAccount.username,'acme');assert.equal(result.capabilities.instagramProfessionalDiscovery.ready,true)
  assert.doesNotMatch(JSON.stringify(result),/access_token|secret/i)
})

test('cross-tenant discovery fails closed and expired auth becomes reconnect_required',async()=>{
  const db=dbFor();const expired=createMockChannelProviderAdapter('meta',{discoveryError:new ChannelProviderError('token_expired','raw-token-must-not-leak')})
  const service=createChannelOAuthService({db,adapters:{meta:expired}})
  await assert.rejects(service.discoverMeta({id:'c1',userId:'u2',projectId:'p1'}),{code:'NOT_FOUND'})
  await assert.rejects(service.discoverMeta({id:'c1',userId:'u1',projectId:'p1'}),error=>error.code==='token_expired'&&!error.message.includes('raw-token'))
  assert.equal(db.row.status,'reconnect_required');assert.equal(db.row.last_error_code,'token_expired')
})

test('disconnect revokes scoped connection and reconnect returns mock OAuth start only',async()=>{
  const db=dbFor();const adapter=createMockChannelProviderAdapter('meta');const service=createChannelOAuthService({db,adapters:{meta:adapter},nodeEnv:'test'})
  const disconnected=await service.disconnectMeta({id:'c1',userId:'u1',projectId:'p1'});assert.equal(disconnected.connection.status,'revoked')
  db.row.status='revoked';const reconnect=await service.reconnect({id:'c1',userId:'u1',projectId:'p1',redirectUri:'http://localhost:3000/dashboard/connections'})
  assert.equal(reconnect.mock,true);assert.match(reconnect.authorizationUrl,/^https:\/\/mock\.invalid\/meta\//);assert.doesNotMatch(JSON.stringify(reconnect),/token/i)
})
