import crypto from 'node:crypto'
import { Router } from 'express'
import { pool } from '../db.js'
import { ACCESS_COOKIE } from '../lib/session.js'

export const TEST_TENANTS=Object.freeze({
  alpha:'00000000-0000-4000-8000-000000000001',
  beta:'00000000-0000-4000-8000-000000000002',
})
const EXPECTED_DATABASE='yeeyoo_phase13_test'
const safeEqual=(a,b)=>{const left=Buffer.from(String(a||''));const right=Buffer.from(String(b||''));return left.length===right.length&&crypto.timingSafeEqual(left,right)}
const markerHash=tenant=>crypto.createHash('sha256').update(`phase15:test-session:${tenant}`).digest('hex')
const digest=value=>crypto.createHash('sha256').update(value).digest('hex')
async function createShortTestSession(userId,req,client){const accessToken=crypto.randomBytes(32).toString('base64url');await client.query(`INSERT INTO auth_sessions(id,user_id,access_hash,refresh_hash,family_id,access_expires_at,refresh_expires_at,user_agent,ip_address)
  VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '15 minutes',$6,$7)`,[crypto.randomUUID(),userId,digest(accessToken),digest(crypto.randomBytes(32).toString('base64url')),crypto.randomUUID(),(req.headers['user-agent']||'').slice(0,500),req.ip||null]);return{accessToken}}
function setShortTestCookie(res,session){res.cookie(ACCESS_COOKIE,session.accessToken,{httpOnly:true,secure:false,sameSite:'strict',path:'/',maxAge:15*60*1000});res.set('Cache-Control','no-store')}

export function testSessionEnabled(env=process.env){return env.NODE_ENV==='test'&&env.YEEYOO_ENABLE_TEST_SESSION==='true'&&typeof env.YEEYOO_TEST_SESSION_KEY==='string'&&env.YEEYOO_TEST_SESSION_KEY.length>=32&&Boolean(env.YEEYOO_TEST_DATABASE_URL)}

export function createTestSessionRouter({db=pool,env=process.env,create=createShortTestSession,setCookies=setShortTestCookie}={}){
  const r=Router()
  r.post('/',async(req,res)=>{
    if(!testSessionEnabled(env))return res.status(404).json({error:'Not found'})
    const tenant=String(req.body?.tenant||'');const userId=TEST_TENANTS[tenant]
    if(!userId||!safeEqual(req.get('X-Yeeyoo-Test-Key'),env.YEEYOO_TEST_SESSION_KEY))return res.status(403).json({error:'Forbidden'})
    const client=await db.connect()
    try{
      await client.query('BEGIN')
      const identity=await client.query('SELECT current_database() AS name')
      if(identity.rows[0]?.name!==EXPECTED_DATABASE)throw Object.assign(new Error('Test database identity rejected'),{code:'IDENTITY_REJECTED'})
      const user=await client.query('SELECT id,name,email,is_admin FROM users WHERE id=$1 AND email=$2 FOR UPDATE',[userId,`${tenant==='alpha'?'alpha':'beta'}@yeeyoo.invalid`])
      if(!user.rows[0])throw Object.assign(new Error('Allowlisted test fixture missing'),{code:'FIXTURE_MISSING'})
      const claimed=await client.query(`INSERT INTO auth_exchange_codes(id,user_id,code_hash,expires_at,consumed_at)
        VALUES($1,$2,$3,NOW()+INTERVAL '2 minutes',NOW()) ON CONFLICT(code_hash) DO NOTHING RETURNING id`,[crypto.randomUUID(),userId,markerHash(tenant)])
      if(!claimed.rows[0])throw Object.assign(new Error('Test session bootstrap already used'),{code:'ALREADY_USED'})
      const session=await create(userId,req,client)
      await client.query('COMMIT')
      setCookies(res,session)
      return res.status(201).json({user:user.rows[0],tenant,expiresInSeconds:900})
    }catch(error){await client.query('ROLLBACK').catch(()=>{});const status=error.code==='ALREADY_USED'?409:error.code==='IDENTITY_REJECTED'?404:500;return res.status(status).json({error:status===500?'Test bootstrap unavailable':error.message})}finally{client.release()}
  })
  return r
}
export default createTestSessionRouter()
