import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source=fs.readFileSync(new URL('../src/routes/test-session.js',import.meta.url),'utf8')
test('production-like configuration cannot enable bootstrap',()=>{
  assert.match(source,/env\.NODE_ENV==='test'/);assert.match(source,/env\.YEEYOO_ENABLE_TEST_SESSION==='true'/)
  assert.match(source,/current_database\(\) AS name/);assert.match(source,/EXPECTED_DATABASE='yeeyoo_phase13_test'/)
})
test('proxy headers cannot override direct loopback requirement',()=>{
  const executable=source.replace(/\/\/.*$/gm,'')
  assert.match(executable,/req\.get\('host'\)/);assert.doesNotMatch(executable,/x-forwarded-host/i)
  assert.match(source,/LOCAL_HOSTS\.has/)
})
test('bootstrap remains fixed-tenant one-time and secret-free',()=>{
  assert.match(source,/Object\.freeze/);assert.match(source,/ON CONFLICT\(code_hash\) DO NOTHING/)
  assert.match(source,/timingSafeEqual/);assert.doesNotMatch(source,/res\.json\([^\n]*(?:accessToken|refreshToken)/)
})
