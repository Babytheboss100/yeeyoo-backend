// Streak gamification (HOLO Sesjon J).
//
// bumpStreak() kalles fra logAudit() ved hver vellykkede sosiale post (action
// som slutter på '.post'). Fire-and-forget — kaster aldri. Dag-diff i UTC
// (godt nok for v1; tidssone-presisjon er TODO).

import { pool } from '../db.js'

const DAY_MS = 86_400_000

export async function bumpStreak(userId) {
  if (!userId) return
  try {
    const { rows } = await pool.query('SELECT streak_count, last_post_at FROM users WHERE id=$1', [userId])
    if (!rows[0]) return
    const last = rows[0].last_post_at ? new Date(rows[0].last_post_at) : null
    let streak = rows[0].streak_count || 0

    if (!last) {
      streak = 1
    } else {
      const diff = Math.floor(Date.now() / DAY_MS) - Math.floor(last.getTime() / DAY_MS)
      if (diff <= 0) return // allerede postet i dag → uendret
      streak = diff === 1 ? streak + 1 : 1 // i går → +1, eldre → brutt (reset)
    }
    await pool.query('UPDATE users SET streak_count=$1, last_post_at=NOW() WHERE id=$2', [streak, userId])
  } catch (e) {
    console.error('[streak] bump feilet:', e.message)
  }
}

// Er streaken fortsatt "i live"? (postet i dag eller i går)
export function isStreakAlive(lastPostAt) {
  if (!lastPostAt) return false
  const diff = Math.floor(Date.now() / DAY_MS) - Math.floor(new Date(lastPostAt).getTime() / DAY_MS)
  return diff <= 1
}
