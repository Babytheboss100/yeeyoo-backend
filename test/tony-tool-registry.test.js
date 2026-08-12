import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultTonyRegistry, TONY_PERMISSION } from '../src/tony/toolRegistry.js'

const context = { userId: 'u', projectId: 'p', permissions: [TONY_PERMISSION.CREATE_DRAFT] }
test('Tony registry exposes permissions without handlers or secrets', () => { const tools = createDefaultTonyRegistry().describe(); assert.equal(tools.length, 11); assert.ok(tools.every((t) => !('execute' in t))) })
test('Tony may read and draft within explicit project context', async () => {
  const registry = createDefaultTonyRegistry({ 'marketing_profile.read': async (ctx) => ctx.projectId, 'copy.create_draft': async () => 'draft' })
  assert.equal(await registry.invoke('marketing_profile.read', context), 'p')
  assert.equal(await registry.invoke('copy.create_draft', context), 'draft')
})
test('Tony has no approve, publish, send, spend, connect or delete capability', async () => {
  const registry = createDefaultTonyRegistry()
  for (const forbidden of ['queue.approve', 'queue.publish', 'email.send', 'ads.spend', 'channel.connect', 'project.delete']) {
    await assert.rejects(registry.invoke(forbidden, context), { code: 'TOOL_NOT_FOUND' })
  }
})
test('Tony rejects cross-level privilege and missing tenant context', async () => {
  const registry = createDefaultTonyRegistry({ 'copy.create_draft': async () => 'draft' })
  await assert.rejects(registry.invoke('copy.create_draft', { userId: 'u', projectId: 'p', permissions: [TONY_PERMISSION.READ] }), { code: 'PERMISSION_DENIED' })
  await assert.rejects(registry.invoke('marketing_profile.read', { userId: 'u' }), { code: 'PROJECT_CONTEXT_REQUIRED' })
})
