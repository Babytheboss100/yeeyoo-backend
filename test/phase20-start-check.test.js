import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
const run=env=>spawnSync(process.execPath,['scripts/phase20-start-check.js'],{env,encoding:'utf8'})
const safe={NODE_ENV:'test',YEEYOO_STRICT_TEST_DB:'true',YEEYOO_TEST_DATABASE_URL:'configured-without-printing',PORT:'3001'}
test('strict backend preflight reports identity requirement without URL',()=>{const result=run(safe);assert.equal(result.status,0);const report=JSON.parse(result.stdout);assert.equal(report.databaseIdentityRequired,'yeeyoo_phase13_test');assert.equal(report.providers,'disabled');assert.doesNotMatch(result.stdout,/configured-without-printing/)})
test('backend rejects inherited production database, provider secrets and non-test environment',()=>{for(const env of [{...safe,DATABASE_URL:'production'},{...safe,OPENAI_API_KEY:'secret'},{...safe,NODE_ENV:'development'}]){const result=run(env);assert.notEqual(result.status,0);assert.match(result.stderr,/start refused/)}})

