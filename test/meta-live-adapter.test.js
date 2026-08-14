import test from 'node:test'
import assert from 'node:assert/strict'
import { createMetaConnectionProvider, validateMetaConnectionConfig } from '../src/lib/metaConnectionProvider.js'
import { decryptToken, encryptToken, isEncrypted } from '../src/lib/tokenCrypto.js'

const env={META_APP_ID:'app-id',META_APP_SECRET:'secret-value',META_REDIRECT_URI:'https://backend.invalid/api/oauth/meta/callback',META_TOKEN_ENCRYPTION_KEY:'0123456789abcdef'.repeat(4)}

test('live Meta configuration is exact and authorization requests minimal discovery scopes',()=>{
  assert.deepEqual(validateMetaConnectionConfig(env).scopes,['pages_show_list','instagram_basic'])
  const provider=createMetaConnectionProvider({env,fetchImpl:async()=>{throw new Error('not called')}})
  const url=new URL(provider.authorizationUrl({state:'opaque-state'}))
  assert.equal(url.hostname,'www.facebook.com');assert.equal(url.searchParams.get('state'),'opaque-state')
  assert.equal(url.searchParams.get('scope'),'pages_show_list,instagram_basic');assert.equal(url.searchParams.has('client_secret'),false)
})

test('token exchange and discovery keep credentials in headers/body and normalize safe output',async()=>{
  const calls=[];const fetchImpl=async(url,options={})=>{calls.push({url:String(url),options});if(String(url).includes('/oauth/access_token'))return{ok:true,json:async()=>({access_token:'provider-token',expires_in:3600})};if(String(url).includes('/me/accounts'))return{ok:true,json:async()=>({data:[{id:'p1',name:'Yeeyoo',instagram_business_account:{id:'ig1',username:'yeeyoo'}}]})};return{ok:true,json:async()=>({id:'u1',name:'Owner'})}}
  const provider=createMetaConnectionProvider({env,fetchImpl});const token=await provider.exchange({code:'one-time-code'});assert.equal(token.accessToken,'provider-token')
  const identity=await provider.identity({accessToken:token.accessToken});const discovery=await provider.discoverAccounts({accessToken:token.accessToken})
  assert.equal(identity.id,'u1');assert.equal(discovery.pages[0].instagramProfessionalAccount.id,'ig1')
  assert.ok(calls.slice(1).every(call=>!call.url.includes('provider-token')));assert.ok(calls.slice(1).every(call=>call.options.headers.Authorization==='Bearer provider-token'))
})

test('server token encryption is authenticated and reversible without plaintext persistence',()=>{
  const previous=process.env.META_TOKEN_ENCRYPTION_KEY;process.env.META_TOKEN_ENCRYPTION_KEY=env.META_TOKEN_ENCRYPTION_KEY
  try{const encrypted=encryptToken('provider-token');assert.equal(isEncrypted(encrypted),true);assert.doesNotMatch(encrypted,/provider-token/);assert.equal(decryptToken(encrypted),'provider-token')}finally{if(previous===undefined)delete process.env.META_TOKEN_ENCRYPTION_KEY;else process.env.META_TOKEN_ENCRYPTION_KEY=previous}
})
