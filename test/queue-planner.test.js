import test from 'node:test'
import assert from 'node:assert/strict'
import { buildContentQueueQuery } from '../src/marketing/contentQueue.js'
import { buildPlannerCalendarQuery, normalizeRequestedPlatforms } from '../src/marketing/smartPlanner.js'

test('content queue filters by tenant project and platform', () => {
  const result = buildContentQueueQuery({ userId: 'u1', projectId: 'p1', status: 'pending', platform: 'linkedin' })
  assert.match(result.sql, /p\.user_id=\$1/)
  assert.match(result.sql, /p\.project_id=\$3/)
  assert.match(result.sql, /p\.platform=\$4/)
  assert.deepEqual(result.params, ['u1', 'pending', 'p1', 'linkedin'])
})

test('Smart Planner calendar includes project filter', () => {
  const result = buildPlannerCalendarQuery({ userId: 'u1', projectId: 'p1', startDate: 'a', endDate: 'b' })
  assert.match(result.sql, /p\.project_id=\$4/)
  assert.deepEqual(result.params, ['u1', 'a', 'b', 'p1'])
})

test('requested platforms are normalized and enforced', () => {
  assert.deepEqual(normalizeRequestedPlatforms(['LinkedIn', 'linkedin', 'X']), ['linkedin', 'x'])
  assert.throws(() => normalizeRequestedPlatforms(['myspace']))
})
