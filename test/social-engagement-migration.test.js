import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const sql=fs.readFileSync(new URL('../migrations/2026-08-24_sosy_engagement_foundation.sql',import.meta.url),'utf8')
test('engagement persistence is tenant-bound, replay-safe and future-ready',()=>{for(const term of ['FOREIGN KEY(project_id,user_id)','FOREIGN KEY(interaction_id,user_id,project_id)','UNIQUE(user_id,project_id,provider,provider_account_id,provider_interaction_id)','UNIQUE(user_id,project_id,idempotency_key)','WAITING_APPROVAL','social_engagement_trigger_rules','approval_required','expires_at','social_engagement_escalations','assigned_owner_id','follow_up_at','OBSERVATION','HYPOTHESIS','RECOMMENDATION'])assert.match(sql,new RegExp(term.replace(/[()]/g,'\\$&')))})
