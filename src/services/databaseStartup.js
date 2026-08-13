import { discoverMigrations } from './migrationRunner.js'

export const STRICT_TEST_DATABASE='yeeyoo_phase13_test'
export function strictTestMode(env=process.env){return env.NODE_ENV==='test'&&env.YEEYOO_STRICT_TEST_DB==='true'}
export function databaseUrlForRuntime(env=process.env){
  if(strictTestMode(env)){
    if(!env.YEEYOO_TEST_DATABASE_URL)throw new Error('Strict test mode requires YEEYOO_TEST_DATABASE_URL')
    return env.YEEYOO_TEST_DATABASE_URL
  }
  if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required')
  return env.DATABASE_URL
}
export function databaseSslForRuntime(env=process.env){
  if(strictTestMode(env))return{rejectUnauthorized:false}
  return env.NODE_ENV==='production'?{rejectUnauthorized:false}:false
}

const REQUIRED=Object.freeze({
  users:['id','email'],projects:['id','user_id'],auth_sessions:['id','user_id','access_hash','revoked_at'],
  ai_jobs:['id','user_id','project_id','status'],project_activity:['id','user_id','project_id','event_type'],
})

// Read-only startup verification. Schema mutation belongs exclusively to the
// migration command and never to an API process in strict test mode.
export async function verifyStrictTestDatabase(client,{migrations}={}){
  const identity=await client.query('SELECT current_database() AS name')
  if(identity.rows[0]?.name!==STRICT_TEST_DATABASE)throw new Error('Strict test database identity rejected')
  const files=migrations||await discoverMigrations()
  const ledger=await client.query(`SELECT name,checksum FROM schema_migrations ORDER BY name`)
  const applied=new Map(ledger.rows.map(row=>[row.name,row.checksum]))
  const missing=[]
  for(const file of files){if(!applied.has(file.name))missing.push(file.name);else if(applied.get(file.name)!==file.checksum)throw new Error(`Applied migration changed: ${file.name}`)}
  const unknown=[...applied.keys()].filter(name=>!files.some(file=>file.name===name))
  if(missing.length||unknown.length)throw new Error(`Migration ledger mismatch: ${missing.length} missing, ${unknown.length} unknown`)
  const compatibility=await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`,[Object.keys(REQUIRED)])
  const available=new Set(compatibility.rows.map(row=>`${row.table_name}.${row.column_name}`))
  const absent=Object.entries(REQUIRED).flatMap(([table,columns])=>columns.map(column=>`${table}.${column}`)).filter(key=>!available.has(key))
  if(absent.length)throw new Error(`Schema compatibility check failed: ${absent.join(', ')}`)
  return{database:STRICT_TEST_DATABASE,migrations:files.length,compatibilityChecks:available.size,readOnly:true}
}

export function createGracefulShutdown({pool,exit=()=>{},timeout=setTimeout,clear=clearTimeout,timeoutMs=5000}={}){
  let closing=null
  return async function shutdown(signal='shutdown'){
    if(closing)return closing
    closing=(async()=>{let timer;try{await Promise.race([pool.end(),new Promise((_,reject)=>{timer=timeout(()=>reject(new Error('Database pool shutdown timed out')),timeoutMs)})]);exit(0,signal)}catch{exit(1,signal)}finally{if(timer)clear(timer)}})()
    return closing
  }
}
