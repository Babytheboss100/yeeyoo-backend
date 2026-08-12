// Meta Graph API — Facebook Page + Instagram posting (HOLO Sesjon J).
//
// Direkte mot Graph API. Hver Yeeyoo-kunde/prosjekt har egen meta_accounts-rad
// (Page + IG + token + whitelabel display_name). Ingen auto-connect: rader
// settes manuelt.

import { pool } from '../db.js'
import { decryptToken } from './tokenCrypto.js'
import { getMetaProvider } from './metaProvider.js'

// Finn posting-konto. Eksplisitt accountId vinner; ellers første aktive for
// (user, project). Alltid tenant-isolert på userId.
export async function resolveMetaAccount({ userId, projectId, accountId }) {
  if (accountId) {
    const params = [accountId, userId]
    let projectClause = ''
    if (projectId) { params.push(projectId); projectClause = ' AND project_id=$3' }
    const { rows } = await pool.query(
      `SELECT * FROM meta_accounts WHERE id=$1 AND user_id=$2${projectClause}`, params
    )
    return rows[0] || null
  }
  const params = [userId]
  let where = 'user_id = $1 AND active = TRUE'
  if (projectId) {
    params.push(projectId)
    where += ` AND project_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT * FROM meta_accounts WHERE ${where} ORDER BY created_at ASC LIMIT 1`, params
  )
  return rows[0] || null
}

export async function postToFacebookPage({ account, message, link, imageUrl }) {
  if (!account.page_id) throw new Error('Kontoen har ingen tilkoblet Facebook Page')
  if (account.token_expires_at && new Date(account.token_expires_at) <= new Date()) throw new Error('Meta token expired')
  const accessToken = decryptToken(account.access_token)
  return getMetaProvider().publishFacebook({ account, accessToken, message, link, imageUrl })
}

// Instagram krever to steg: opprett media-container, så publiser.
export async function postToInstagram({ account, imageUrl, caption }) {
  if (!account.ig_user_id) throw new Error('Kontoen har ingen tilkoblet Instagram-konto')
  if (!imageUrl) throw new Error('Instagram-innlegg krever imageUrl')
  if (account.token_expires_at && new Date(account.token_expires_at) <= new Date()) throw new Error('Meta token expired')
  const accessToken = decryptToken(account.access_token)
  return getMetaProvider().publishInstagram({ account, accessToken, imageUrl, caption })
}
