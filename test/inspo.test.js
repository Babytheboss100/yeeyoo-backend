import test from 'node:test'
import assert from 'node:assert/strict'
import router from '../src/routes/inspo.js'

test('Inspo router exposes its smoke-tested route stack', () => {
  const methods = router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods))
  assert.ok(methods.includes('get'))
  assert.ok(methods.includes('post'))
})
