import test from 'node:test'
import assert from 'node:assert/strict'

async function load(env, tag) {
  const previous = { ...process.env }
  Object.assign(process.env, env)
  const mod = await import(`../src/middleware/security.js?${tag}`)
  process.env = previous
  return mod
}
const check = (options, origin) => new Promise(resolve => options.origin(origin, (error, allowed) => resolve({ error, allowed })))

test('canonical Phase25 browser origin is allowed only under strict test gates', async () => {
  const strict = await load({ NODE_ENV:'test', YEEYOO_STRICT_TEST_DB:'true', YEEYOO_ENABLE_TEST_SESSION:'true' }, 'strict')
  assert.deepEqual(await check(strict.corsOptions, 'http://127.0.0.1:3100'), { error:null, allowed:true })
  const ordinary = await load({ NODE_ENV:'development', YEEYOO_STRICT_TEST_DB:'false', YEEYOO_ENABLE_TEST_SESSION:'false' }, 'ordinary')
  const denied = await check(ordinary.corsOptions, 'http://127.0.0.1:3100')
  assert.equal(denied.allowed, undefined)
  assert.equal(denied.error.status, 403)
  assert.equal(denied.error.code, 'ORIGIN_NOT_ALLOWED')
  assert.doesNotMatch(denied.error.message, /127\.0\.0\.1|origin:/i)
})
