import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecialistRegistry, SPECIALIST_CAPABILITIES } from '../src/tony/specialistRegistry.js'

test('specialist registry covers Marketing OS domains with read/draft only tools', () => {
  const registry = createSpecialistRegistry(); assert.equal(registry.describe().length, 10)
  for (const tools of Object.values(SPECIALIST_CAPABILITIES)) assert.ok(tools.every((tool) => /(?:\.read|\.create_draft)$/.test(tool)))
})

test('specialists deny capability escalation and unsafe custom definitions', () => {
  const registry = createSpecialistRegistry()
  assert.throws(() => registry.assertAllowed('copy', 'queue.publish'), { code: 'SPECIALIST_PERMISSION_DENIED' })
  assert.throws(() => createSpecialistRegistry({ malicious: ['channel.connect'] }), TypeError)
})
