import test from 'node:test'
import assert from 'node:assert/strict'
import { createChannelOAuthService, validateChannelOAuthRedirect } from '../src/lib/channelOAuthService.js'
import { CHANNEL_PROVIDERS } from '../src/lib/channelProviderAdapters.js'

function fakeDb() {
  const states = new Map(); const connections = []
  return { states, connections, async query(sql, params) {
    if (sql.includes('INSERT INTO channel_oauth_states')) { states.set(params[1], { user_id: params[2], project_id: params[3], provider: params[4], redirect_uri: params[5] }); return { rows: [] } }
    if (sql.includes('DELETE FROM channel_oauth_states')) { const row = states.get(params[0]); if (!row || row.user_id !== params[1] || row.project_id !== params[2] || row.provider !== params[3] || row.expired) return { rows: [] }; states.delete(params[0]); return { rows: [row] } }
    if (sql.includes('INSERT INTO channel_connections')) { const row = { id: params[0], user_id: params[1], project_id: params[2], provider: params[3], provider_account_id: params[4], scopes: params[5], status: 'connected', active: true }; connections.push(row); return { rows: [row] } }
    if (sql.includes('SELECT id,user_id,project_id,provider')) return { rows: connections.filter(row => row.user_id === params[0] && row.project_id === params[1]) }
    if (sql.includes("UPDATE channel_connections SET status='revoked'")) { const row=connections.find(item=>item.id===params[0]&&item.user_id===params[1]&&item.project_id===params[2]); if(!row)return{rows:[]};row.status='revoked';return{rows:[row]} }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
}

test('all six channel OAuth contracts persist state and return secret-free mock connection', async () => {
  for (const provider of CHANNEL_PROVIDERS) {
    const db = fakeDb(); const service = createChannelOAuthService({ db, frontendUrl:'http://localhost:3000' })
    const start = await service.start({ userId: 'u1', projectId: 'p1', provider, redirectUri: 'http://localhost:3000/dashboard/connections' })
    assert.equal(start.mock, true); assert.match(start.authorizationUrl, /^https:\/\/mock\.invalid\//)
    const result = await service.callback({ userId:'u1', projectId: 'p1', provider, state: start.state, code: 'mock-code' })
    assert.equal(result.connection.projectId, 'p1'); assert.equal(JSON.stringify(result).includes('mock-code'), false)
    await assert.rejects(service.callback({ userId:'u1', projectId: 'p1', provider, state: start.state, code: 'replay' }), { code: 'INVALID_OAUTH_STATE' })
  }
})

test('OAuth callback cannot cross project boundary', async () => {
  const db = fakeDb(); const service = createChannelOAuthService({ db, frontendUrl:'http://localhost:3000' })
  const start = await service.start({ userId: 'u1', projectId: 'p1', provider: 'meta', redirectUri: 'http://localhost:3000/dashboard/connections' })
  await assert.rejects(service.callback({ userId:'u1', projectId: 'p2', provider: 'meta', state: start.state, code: 'x' }), { code: 'INVALID_OAUTH_STATE' })
})

test('connections list and revoke are scoped and secret-free', async()=>{
  const db=fakeDb();const service=createChannelOAuthService({db,frontendUrl:'http://localhost:3000'})
  const start=await service.start({userId:'u1',projectId:'p1',provider:'meta',redirectUri:'http://localhost:3000/dashboard/connections'})
  const connected=await service.callback({userId:'u1',projectId:'p1',provider:'meta',state:start.state,code:'code'})
  const listed=await service.list({userId:'u1',projectId:'p1'});assert.equal(listed.connections.length,1)
  const revoked=await service.revoke({id:connected.connection.id,userId:'u1',projectId:'p1'});assert.equal(revoked.connection.status,'revoked')
  await assert.rejects(service.revoke({id:connected.connection.id,userId:'u2',projectId:'p1'}),{code:'NOT_FOUND'})
  assert.doesNotMatch(JSON.stringify({listed,revoked}),/code|token|secret/i)
})

test('OAuth callback rejects wrong user and wrong provider without consuming valid state',async()=>{
  const db=fakeDb();const service=createChannelOAuthService({db,frontendUrl:'http://localhost:3000'})
  const start=await service.start({userId:'u1',projectId:'p1',provider:'meta',redirectUri:'http://localhost:3000/dashboard/connections'})
  await assert.rejects(service.callback({userId:'u2',projectId:'p1',provider:'meta',state:start.state,code:'x'}),{code:'INVALID_OAUTH_STATE'})
  await assert.rejects(service.callback({userId:'u1',projectId:'p1',provider:'linkedin',state:start.state,code:'x'}),{code:'INVALID_OAUTH_STATE'})
  const result=await service.callback({userId:'u1',projectId:'p1',provider:'meta',state:start.state,code:'x'})
  assert.equal(result.connection.projectId,'p1')
})

test('expired state, missing code and provider errors fail closed',async()=>{
  const db=fakeDb();const service=createChannelOAuthService({db,frontendUrl:'http://localhost:3000'})
  const expired=await service.start({userId:'u1',projectId:'p1',provider:'meta',redirectUri:'http://localhost:3000/dashboard/connections'})
  db.states.get([...db.states.keys()][0]).expired=true
  await assert.rejects(service.callback({userId:'u1',projectId:'p1',provider:'meta',state:expired.state,code:'x'}),{code:'INVALID_OAUTH_STATE'})
  const start=await service.start({userId:'u1',projectId:'p1',provider:'meta',redirectUri:'http://localhost:3000/dashboard/connections'})
  await assert.rejects(service.callback({userId:'u1',projectId:'p1',provider:'meta',state:start.state}),/code is required/i)
  await assert.rejects(service.callback({userId:'u1',projectId:'p1',provider:'meta',state:start.state,code:'ignored',error:'access_denied'}),{code:'OAUTH_PROVIDER_ERROR'})
})

test('OAuth redirect validation prevents open redirects and unsafe URI forms',()=>{
  const options={frontendUrl:'https://app.invalid',nodeEnv:'production'}
  assert.equal(validateChannelOAuthRedirect('https://app.invalid/dashboard/connections',options),'https://app.invalid/dashboard/connections')
  for(const value of ['https://evil.invalid/dashboard/connections','javascript:alert(1)','https://app.invalid@evil.invalid/dashboard/connections','https://app.invalid/dashboard/connections#token','https://app.invalid/dashboard/connections?next=https://evil.invalid','https://app.invalid/other'])
    assert.throws(()=>validateChannelOAuthRedirect(value,options))
})
