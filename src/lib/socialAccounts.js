// Delte hjelpere for plattform-konto-tabeller (linkedin/x/tiktok/pinterest).
// Alle oppslag er tenant-isolert på userId. Token-kryptering håndteres i
// rutene (eksplisitt per token-kolonne ved insert; decrypt ved bruk).

import { pool } from '../db.js'

// Finn én konto. Eksplisitt accountId vinner; ellers første aktive for (user,
// project). Returnerer rå rad (token fortsatt kryptert — decrypt ved bruk).
export async function resolveAccount(table, { userId, projectId, accountId }) {
  if (accountId) {
    const params = [accountId, userId]
    let where = 'id=$1 AND user_id=$2'
    if (projectId) {
      params.push(projectId)
      where += ` AND project_id=$${params.length}`
    }
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE ${where}`, params)
    return rows[0] || null
  }
  const params = [userId]
  let where = 'user_id = $1 AND active = TRUE'
  if (projectId) {
    params.push(projectId)
    where += ` AND project_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE ${where} ORDER BY created_at ASC LIMIT 1`, params
  )
  return rows[0] || null
}

export function accountNeedsReconnect(account, now = new Date()) {
  if (!account?.expires_at) return false
  const expiresAt = new Date(account.expires_at)
  return Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= new Date(now).getTime()
}

// Tenant-isolert liste over angitte (ikke-sensitive) kolonner.
export async function listAccounts(table, columns, { userId, projectId }) {
  const params = [userId]
  let where = 'user_id = $1'
  if (projectId) {
    params.push(projectId)
    where += ` AND project_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT ${columns.join(', ')} FROM ${table} WHERE ${where} ORDER BY created_at ASC`, params
  )
  return rows
}
