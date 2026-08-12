import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const seed = fs.readFileSync(new URL('../scripts/seed-test.js', import.meta.url), 'utf8')

test('database seed requires a dedicated explicit test database authority', () => {
  assert.match(seed, /NODE_ENV !== 'test'/)
  assert.match(seed, /YEEYOO_TEST_DATABASE_URL/)
  assert.doesNotMatch(seed, /process\.env\.DATABASE_URL/)
})

test('deterministic rehearsal seed declares two tenants and A1 A2 B1 projects', () => {
  assert.match(seed, /alpha@yeeyoo\.invalid/)
  assert.match(seed, /beta@yeeyoo\.invalid/)
  assert.match(seed, /Alpha Project A1/)
  assert.match(seed, /Alpha Project A2/)
  assert.match(seed, /Beta Project B1/)
  assert.match(seed, /BEGIN/)
  assert.match(seed, /ROLLBACK/)
})
