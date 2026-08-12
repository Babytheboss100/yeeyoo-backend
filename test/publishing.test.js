import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPublish } from '../src/publishing/service.js'
import { mockPublishingAdapter } from '../src/publishing/mockAdapter.js'

test('approval workflow blocks pending and permits approved posts', () => {
  assert.equal(classifyPublish({ status: 'pending' }), 'not-approved')
  assert.equal(classifyPublish({ status: 'approved' }), 'publish')
})

test('published state and successful attempts are idempotent', () => {
  assert.equal(classifyPublish({ status: 'published' }), 'idempotent')
  assert.equal(classifyPublish({ status: 'approved' }, { status: 'published' }), 'idempotent')
})

test('mock adapter exposes deterministic success and failure states without provider calls', async () => {
  const result = await mockPublishingAdapter.publish({ post: { content: 'Hello' }, idempotencyKey: 'u:p' })
  assert.equal(result.externalId, 'mock_u:p')
  await assert.rejects(mockPublishingAdapter.publish({ post: { content: '[MOCK_PUBLISH_FAIL]' }, idempotencyKey: 'u:p2' }), /Mock publish failure/)
})
