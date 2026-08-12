// TEST/LOCAL ADAPTER ONLY. It never contacts a provider.
export const mockPublishingAdapter = Object.freeze({
  id: 'mock-local',
  async publish({ post, idempotencyKey }) {
    if (post.content?.includes('[MOCK_PUBLISH_FAIL]')) throw new Error('Mock publish failure')
    return { provider: 'mock-local', externalId: `mock_${idempotencyKey}`, status: 'published' }
  },
})
