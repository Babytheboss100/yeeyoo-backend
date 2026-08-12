import test from 'node:test'
import assert from 'node:assert/strict'
import { bumpStreak, dayKey, nextStreak } from '../src/lib/streak.js'

test('timezone day boundary uses the project timezone', () => {
  const instant = '2026-03-29T22:30:00.000Z'
  assert.equal(dayKey(instant, 'UTC'), '2026-03-29')
  assert.equal(dayKey(instant, 'Europe/Oslo'), '2026-03-30')
})

test('duplicate publish event does not bump streak twice', async () => {
  let eventInserted = true
  let updates = 0
  const db = { query: async (sql) => {
    if (sql.includes('INSERT INTO streak_events')) { const inserted = eventInserted; eventInserted = false; return { rows: inserted ? [{ id: 'e1' }] : [] } }
    if (sql.includes('SELECT streak_count')) return { rows: [{ streak_count: 2, last_post_at: null }] }
    if (sql.includes('UPDATE users')) { updates += 1; return { rows: [] } }
    return { rows: [] }
  } }
  await bumpStreak('u1', { eventKey: 'publish:p1', db })
  await bumpStreak('u1', { eventKey: 'publish:p1', db })
  assert.equal(updates, 1)
})

test('same-day publish is idempotent and next day increments', () => {
  assert.equal(nextStreak({ count: 4, lastPostAt: '2026-08-12T08:00:00Z', occurredAt: '2026-08-12T20:00:00Z' }), 4)
  assert.equal(nextStreak({ count: 4, lastPostAt: '2026-08-11T20:00:00Z', occurredAt: '2026-08-12T08:00:00Z' }), 5)
})
