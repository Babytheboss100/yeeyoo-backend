import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {parseCookies,setSessionCookies,clearSessionCookies,sessionConstants} from '../src/lib/session.js'
import {approvalFingerprint,authorizeAutopilot} from '../src/tony/autopilotPolicy.js'

test('malformed cookie encoding fails closed without crashing auth routes',()=>{
  assert.deepEqual(parseCookies('yeeyoo_session=%E0%A4%A; safe=value'),{safe:'value'})
  assert.deepEqual(parseCookies('broken; =bad; x=%ZZ'),{})
})

test('cookie write and clear preserve HttpOnly Secure SameSite path and exact lifetimes',()=>{
  const old=process.env.NODE_ENV;process.env.NODE_ENV='production';const writes=[],clears=[],headers=[]
  const res={cookie:(...x)=>writes.push(x),clearCookie:(...x)=>clears.push(x),set:(...x)=>headers.push(x)}
  try{setSessionCookies(res,{accessToken:'access',refreshToken:'refresh'});clearSessionCookies(res)}finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old}
  assert.deepEqual(writes.map(x=>x[2].maxAge),[sessionConstants.ACCESS_TTL_MS,sessionConstants.REFRESH_TTL_MS])
  for(const [,value,options] of writes){assert.ok(value);assert.equal(options.httpOnly,true);assert.equal(options.secure,true);assert.equal(options.sameSite,'lax');assert.equal(options.path,'/')}
  for(const [,options] of clears){assert.equal(options.httpOnly,true);assert.equal(options.secure,true);assert.equal(options.sameSite,'lax');assert.equal(options.path,'/');assert.equal(options.maxAge,0)}
  assert.ok(headers.every(([name,value])=>name==='Cache-Control'&&value==='no-store'))
})

test('refresh exchange and logout require trusted origin, revoke and clear',()=>{
  const source=fs.readFileSync(new URL('../src/routes/auth.js',import.meta.url),'utf8')
  for(const route of ['refresh','exchange','logout'])assert.match(source,new RegExp(`r\\.post\\('/${route}', requireTrustedOrigin`))
  const refresh=source.slice(source.indexOf("r.post('/refresh'"),source.indexOf("r.post('/exchange'"))
  assert.match(refresh,/if \(!session\)[\s\S]*clearSessionCookies/)
  assert.match(refresh,/catch[\s\S]*clearSessionCookies/)
  const logout=source.slice(source.indexOf("r.post('/logout'"),source.indexOf("r.get('/verify'"))
  assert.match(logout,/revokeSession/);assert.match(logout,/finally[\s\S]*clearSessionCookies/)
})

test('test-session bootstrap stays test-only keyed identity-bound one-time and strict-cookie',()=>{
  const source=fs.readFileSync(new URL('../src/routes/test-session.js',import.meta.url),'utf8')
  for(const invariant of ["env.NODE_ENV==='test'","YEEYOO_ENABLE_TEST_SESSION==='true'","YEEYOO_TEST_SESSION_KEY.length>=32","current_database() AS name","yeeyoo_phase13_test","ON CONFLICT(code_hash) DO NOTHING","sameSite:'strict'","httpOnly:true"])assert.ok(source.includes(invariant),invariant)
  assert.doesNotMatch(source,/res\.json\([^\n]*(?:accessToken|refreshToken)/)
})

test('Approval-Autopilot remains bound across tenant fingerprint expiry and replay',()=>{
  const now=Date.parse('2026-05-01T12:00:00Z'),policy={level:3,version:2,projectId:'p1',campaignId:'c1',maxBudget:10,currency:'NOK',channels:['mock']}
  const context={userId:'u1',projectId:'p1',campaignId:'c1',planId:'plan',artifactId:'a',artifactVersion:1,budget:10,currency:'NOK',channels:['mock'],providerConnected:true,providerConnectionId:'conn',providerConnectionVersion:1,approvalNonce:'nonce'}
  const approval={status:'approved',action:'publish',userId:'u1',projectId:'p1',campaignId:'c1',approvedByUserId:'owner',approvedAt:'2026-05-01T11:00:00Z',expiresAt:'2026-05-01T13:00:00Z',nonce:'nonce',fingerprint:approvalFingerprint({...context,action:'publish',policyVersion:2})}
  assert.equal(authorizeAutopilot({policy,action:'publish',context,approval,now}).allowed,true)
  for(const changed of [{...approval,userId:'u2'},{...approval,fingerprint:'0'.repeat(64)},{...approval,expiresAt:'2026-05-01T10:00:00Z'},{...approval,consumed_at:'2026-05-01T11:30:00Z'}])assert.equal(authorizeAutopilot({policy,action:'publish',context,approval:changed,now}).allowed,false)
})
