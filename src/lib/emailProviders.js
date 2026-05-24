// E-post-integrasjoner: Klaviyo + Mailchimp (HOLO Sesjon J, #9).
// Hver funksjon tar en integration-rad (med dekryptert apiKey) + data.

// ─── Klaviyo ─────────────────────────────────────────────────────────────────
const KLAVIYO_REVISION = '2024-10-15'

export async function klaviyoSubscribe({ apiKey, listId }, contacts) {
  if (!listId) throw new Error('Klaviyo list_id mangler')
  const profiles = contacts.filter((c) => c.email).map((c) => ({
    type: 'profile',
    attributes: {
      email: c.email,
      ...(c.firstName || c.lastName ? { first_name: c.firstName, last_name: c.lastName } : {}),
      subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
    },
  }))
  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: { profiles: { data: profiles } },
        relationships: { list: { data: { type: 'list', id: listId } } },
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Klaviyo ${res.status}: ${body.slice(0, 200)}`)
  }
  return { subscribed: profiles.length }
}

export async function klaviyoSendCampaign() {
  // Klaviyo-kampanjer krever opprettelse av campaign + message + template + send-job
  // (flertrinns). Ikke implementert i MVP — flagget for oppfølging.
  const e = new Error('Klaviyo campaign-sending er ikke implementert ennå (krever template-oppsett)')
  e.statusCode = 501
  throw e
}

// ─── Mailchimp ───────────────────────────────────────────────────────────────
export async function mailchimpSubscribe({ apiKey, serverPrefix, listId }, contacts) {
  const dc = serverPrefix || apiKey.split('-')[1]
  if (!dc) throw new Error('Mailchimp datacenter (server_prefix) mangler')
  if (!listId) throw new Error('Mailchimp audience_id mangler')
  const members = contacts.filter((c) => c.email).map((c) => ({
    email_address: c.email,
    status: 'subscribed',
    ...(c.firstName || c.lastName ? { merge_fields: { FNAME: c.firstName || '', LNAME: c.lastName || '' } } : {}),
  }))
  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${listId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ members, update_existing: true }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Mailchimp ${res.status}: ${data?.detail || ''}`)
  return { created: data.total_created ?? 0, updated: data.updated_members?.length ?? 0, errors: data.error_count ?? 0 }
}

export async function mailchimpSendCampaign({ apiKey, serverPrefix, listId }, { subject, fromName, replyTo, html }) {
  const dc = serverPrefix || apiKey.split('-')[1]
  if (!dc) throw new Error('Mailchimp datacenter (server_prefix) mangler')
  if (!listId) throw new Error('Mailchimp audience_id mangler')
  const base = `https://${dc}.api.mailchimp.com/3.0`
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

  // 1) Opprett kampanje
  const createRes = await fetch(`${base}/campaigns`, {
    method: 'POST', headers,
    body: JSON.stringify({
      type: 'regular',
      recipients: { list_id: listId },
      settings: { subject_line: subject, from_name: fromName, reply_to: replyTo, title: subject },
    }),
  })
  const campaign = await createRes.json().catch(() => ({}))
  if (!createRes.ok || !campaign.id) throw new Error(`Mailchimp create ${createRes.status}: ${campaign?.detail || ''}`)

  // 2) Sett innhold
  const contentRes = await fetch(`${base}/campaigns/${campaign.id}/content`, {
    method: 'PUT', headers, body: JSON.stringify({ html }),
  })
  if (!contentRes.ok) {
    const b = await contentRes.json().catch(() => ({}))
    throw new Error(`Mailchimp content ${contentRes.status}: ${b?.detail || ''}`)
  }

  // 3) Send
  const sendRes = await fetch(`${base}/campaigns/${campaign.id}/actions/send`, { method: 'POST', headers })
  if (sendRes.status !== 204 && !sendRes.ok) {
    const b = await sendRes.json().catch(() => ({}))
    throw new Error(`Mailchimp send ${sendRes.status}: ${b?.detail || ''}`)
  }
  return { campaignId: campaign.id }
}
