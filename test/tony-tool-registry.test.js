import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultTonyRegistry, TONY_PERMISSION } from '../src/tony/toolRegistry.js'

const context = { userId: 'u', projectId: 'p', permissions: [TONY_PERMISSION.PUBLISH] }
test('Tony registry exposes permissions without handlers or secrets', () => { const tools = createDefaultTonyRegistry().describe(); assert.equal(tools.length, 8); assert.ok(tools.every((t) => !('execute' in t))) })
test('Tony may read and draft within explicit project context', async () => {
  const registry = createDefaultTonyRegistry({ 'marketing_profile.read': async (ctx) => ctx.projectId, 'copy.create_draft': async () => 'draft' })
  assert.equal(await registry.invoke('marketing_profile.read', context), 'p')
  assert.equal(await registry.invoke('copy.create_draft', context), 'draft')
})
test('Tony cannot silently approve or publish', async () => {
  const registry = createDefaultTonyRegistry({ 'queue.approve': async () => 'approved', 'queue.publish': async () => 'published' })
  await assert.rejects(registry.invoke('queue.approve', context, { confirmationId: 'c' }), { code: 'EXPLICIT_CONFIRMATION_REQUIRED' })
  await assert.rejects(registry.invoke('queue.publish', context, { confirmationId: 'c' }, { confirmed: true, confirmationId: 'wrong' }), { code: 'EXPLICIT_CONFIRMATION_REQUIRED' })
  assert.equal(await registry.invoke('queue.publish', context, { confirmationId: 'c' }, { confirmed: true, confirmationId: 'c' }), 'published')
})
test('Tony rejects cross-level privilege and missing tenant context', async () => {
  const registry = createDefaultTonyRegistry({ 'copy.create_draft': async () => 'draft' })
  await assert.rejects(registry.invoke('copy.create_draft', { userId: 'u', projectId: 'p', permissions: [TONY_PERMISSION.READ] }), { code: 'PERMISSION_DENIED' })
  await assert.rejects(registry.invoke('marketing_profile.read', { userId: 'u' }), { code: 'PROJECT_CONTEXT_REQUIRED' })
})
