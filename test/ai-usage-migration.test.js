import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs'
const sql=fs.readFileSync(new URL('../migrations/2026-08-21_ai_usage_ledger.sql',import.meta.url),'utf8')
test('ledger schema covers scope retries costs ceilings and null-safe idempotency',()=>{for(const term of ['campaign_id','plan_id','plan_step_id','specialist','media_units','provider_cost_usd','estimated_cost_usd','retry_of','UNIQUE NULLS NOT DISTINCT','ai_cost_allowances'])assert.match(sql,new RegExp(term))})
