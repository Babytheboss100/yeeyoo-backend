import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config({ override:true })
const expected='yeeyoo_phase13_test'
async function client(t){const c=new pg.Client({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10_000});await c.connect();t.after(()=>c.end());const{rows}=await c.query('SELECT current_database() name');assert.equal(rows[0]?.name,expected);return c}

test('persisted project scopes separate Tenant A from Tenant B',async t=>{const c=await client(t);const{rows}=await c.query(`SELECT p.id,p.user_id FROM projects p WHERE p.id IN ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001') ORDER BY p.id`);assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.user_id==='00000000-0000-4000-8000-000000000001').length,2);assert.equal(rows.filter(r=>r.user_id==='00000000-0000-4000-8000-000000000002').length,1);const denied=await c.query(`SELECT id FROM projects WHERE user_id=$1 AND id=$2`,['00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001']);assert.equal(denied.rowCount,0)})

test('database rejects cross-tenant project ownership in core domains',async t=>{const c=await client(t);await assert.rejects(c.query(`INSERT INTO marketing_campaigns(id,user_id,project_id,name,status) VALUES('cross-tenant-campaign',$1,$2,'forbidden','draft')`,['00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001']),error=>error.code==='23503');await assert.rejects(c.query(`INSERT INTO channel_connections(id,user_id,project_id,provider,provider_account_id) VALUES('cross-tenant-channel',$1,$2,'mock','forbidden')`,['00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001']),error=>error.code==='23503')})

test('session and OAuth persistence keep one-time uniqueness constraints',async t=>{const c=await client(t);const{rows}=await c.query(`SELECT conrelid::regclass::text table_name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid IN ('auth_sessions'::regclass,'auth_exchange_codes'::regclass)`);const sql=rows.map(r=>`${r.table_name} ${r.definition}`).join('\n');assert.match(sql,/auth_sessions.*UNIQUE \(access_hash\)/i);assert.match(sql,/auth_sessions.*UNIQUE \(refresh_hash\)/i);assert.match(sql,/auth_exchange_codes.*UNIQUE \(code_hash\)/i)})
