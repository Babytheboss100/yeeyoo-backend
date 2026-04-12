import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import crypto from 'crypto'

const router = Router()

// Generate unique referral code for current user
router.post('/generate-code', auth, async (req, res) => {
  try {
    // Check if user already has a code
    const { rows: existing } = await pool.query(
      'SELECT referral_code FROM users WHERE id = $1',
      [req.user.id]
    )
    if (existing[0]?.referral_code) {
      return res.json({ referralCode: existing[0].referral_code })
    }

    // Generate unique 8-char code
    let code
    let unique = false
    while (!unique) {
      code = 'YEE-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8)
      const { rows: check } = await pool.query(
        'SELECT id FROM users WHERE referral_code = $1', [code]
      )
      if (!check.length) unique = true
    }

    await pool.query(
      'UPDATE users SET referral_code = $1 WHERE id = $2',
      [code, req.user.id]
    )

    res.json({ referralCode: code })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get affiliate stats for current user
router.get('/stats', auth, async (req, res) => {
  try {
    const { rows: user } = await pool.query(
      'SELECT referral_code FROM users WHERE id = $1',
      [req.user.id]
    )
    const referralCode = user[0]?.referral_code || null

    // Count referrals
    const { rows: signups } = await pool.query(
      'SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1',
      [req.user.id]
    )

    // Total earnings
    const { rows: earnings } = await pool.query(
      `SELECT COALESCE(SUM(commission), 0) as total
       FROM referrals WHERE referrer_id = $1 AND status = 'paid'`,
      [req.user.id]
    )

    // Pending earnings
    const { rows: pending } = await pool.query(
      `SELECT COALESCE(SUM(commission), 0) as total
       FROM referrals WHERE referrer_id = $1 AND status = 'pending'`,
      [req.user.id]
    )

    // Recent referrals
    const { rows: recent } = await pool.query(
      `SELECT r.id, r.commission, r.status, r.created_at, u.name, u.email
       FROM referrals r
       LEFT JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC LIMIT 20`,
      [req.user.id]
    )

    res.json({
      referralCode,
      referralLink: referralCode
        ? `${process.env.FRONTEND_URL || 'https://app.yeeyoo.no'}?ref=${referralCode}`
        : null,
      signups: parseInt(signups[0].count),
      totalEarnings: parseFloat(earnings[0].total),
      pendingEarnings: parseFloat(pending[0].total),
      recent
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
