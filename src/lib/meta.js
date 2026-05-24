// Meta Graph API — Facebook Page + Instagram posting (HOLO Sesjon J).
//
// Direkte mot Graph API. Hver Yeeyoo-kunde/prosjekt har egen meta_accounts-rad
// (Page + IG + token + whitelabel display_name). Ingen auto-connect: rader
// settes manuelt.

import { pool } from '../db.js'
import { decryptToken } from './tokenCrypto.js'

const GRAPH = 'https://graph.facebook.com/v21.0'

// Finn posting-konto. Eksplisitt accountId vinner; ellers første aktive for
// (user, project). Alltid tenant-isolert på userId.
export async function resolveMetaAccount({ userId, projectId, accountId }) {
  if (accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM meta_accounts WHERE id=$1 AND user_id=$2', [accountId, userId]
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
  const accessToken = decryptToken(account.access_token)
  let url
  let payload
  if (imageUrl) {
    url = `${GRAPH}/${account.page_id}/photos`
    payload = { url: imageUrl, caption: message || '', access_token: accessToken }
  } else {
    url = `${GRAPH}/${account.page_id}/feed`
    payload = { message: message || '', ...(link ? { link } : {}), access_token: accessToken }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Meta API ${res.status}`)
    e.meta = data
    throw e
  }
  return { id: data.post_id || data.id || null, raw: data }
}

// Instagram krever to steg: opprett media-container, så publiser.
export async function postToInstagram({ account, imageUrl, caption }) {
  if (!account.ig_user_id) throw new Error('Kontoen har ingen tilkoblet Instagram-konto')
  if (!imageUrl) throw new Error('Instagram-innlegg krever imageUrl')
  const accessToken = decryptToken(account.access_token)

  const createRes = await fetch(`${GRAPH}/${account.ig_user_id}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption: caption || '', access_token: accessToken }),
  })
  const createData = await createRes.json().catch(() => ({}))
  if (!createRes.ok || !createData.id) {
    const e = new Error(createData?.error?.message || `Meta API ${createRes.status} (media)`)
    e.meta = createData
    throw e
  }

  const pubRes = await fetch(`${GRAPH}/${account.ig_user_id}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: createData.id, access_token: accessToken }),
  })
  const pubData = await pubRes.json().catch(() => ({}))
  if (!pubRes.ok || !pubData.id) {
    const e = new Error(pubData?.error?.message || `Meta API ${pubRes.status} (publish)`)
    e.meta = pubData
    throw e
  }
  return { id: pubData.id, containerId: createData.id, raw: pubData }
}
