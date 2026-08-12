import { pool } from '../db.js'

const DAY_MS = 86_400_000

export function dayKey(value = new Date(), timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const part = (type) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function nextStreak({ count = 0, lastPostAt, occurredAt = new Date(), timeZone = 'UTC' }) {
  if (!lastPostAt) return 1
  const currentKey = dayKey(occurredAt, timeZone)
  const lastKey = dayKey(lastPostAt, timeZone)
  if (currentKey === lastKey) return count
  const toUtc = (key) => { const [year, month, day] = key.split('-').map(Number); return Date.UTC(year, month - 1, day) }
  return Math.round((toUtc(currentKey) - toUtc(lastKey)) / DAY_MS) === 1 ? count + 1 : 1
}

export async function bumpStreak(userId, { eventKey = null, occurredAt = new Date(), timeZone = 'UTC', db = pool } = {}) {
  if (!userId) return
  try {
    if (eventKey) {
      const inserted = await db.query(
        `INSERT INTO streak_events (id,user_id,event_key,occurred_at) VALUES (gen_random_uuid(),$1,$2,$3)
         ON CONFLICT (user_id,event_key) DO NOTHING RETURNING id`, [userId, eventKey, occurredAt]
      )
      if (!inserted.rows[0]) return
    }
    const { rows } = await db.query('SELECT streak_count,last_post_at FROM users WHERE id=$1', [userId])
    if (!rows[0]) return
    const streak = nextStreak({ count: rows[0].streak_count || 0, lastPostAt: rows[0].last_post_at, occurredAt, timeZone })
    await db.query('UPDATE users SET streak_count=$1,last_post_at=$2 WHERE id=$3', [streak, occurredAt, userId])
  } catch (error) {
    console.error('[streak] bump failed:', error.message)
  }
}

export function isStreakAlive(lastPostAt, { now = new Date(), timeZone = 'UTC' } = {}) {
  if (!lastPostAt) return false
  const current = dayKey(now, timeZone)
  const last = dayKey(lastPostAt, timeZone)
  const toUtc = (key) => { const [year, month, day] = key.split('-').map(Number); return Date.UTC(year, month - 1, day) }
  return Math.round((toUtc(current) - toUtc(last)) / DAY_MS) <= 1
}
