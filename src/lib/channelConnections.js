const CAPABILITIES = Object.freeze({
  klaviyo: Object.freeze({ contactsSync: true, campaigns: false, publish: false, inbox: false }),
  mailchimp: Object.freeze({ contactsSync: true, campaigns: true, publish: false, inbox: false }),
  meta: Object.freeze({ contactsSync: false, campaigns: false, publish: true, inbox: true }),
  linkedin: Object.freeze({ contactsSync: false, campaigns: false, publish: true, inbox: false }),
  pinterest: Object.freeze({ contactsSync: false, campaigns: false, publish: true, inbox: false }),
  reddit: Object.freeze({ contactsSync: false, campaigns: false, publish: true, inbox: false }),
  threads: Object.freeze({ contactsSync: false, campaigns: false, publish: true, inbox: false }),
  x: Object.freeze({ contactsSync: false, campaigns: false, publish: true, inbox: false }),
})

export function connectionCapabilities(provider) {
  return { ...(CAPABILITIES[provider] || { contactsSync: false, campaigns: false, publish: false, inbox: false }) }
}

export function connectionStatus(row, now = new Date()) {
  if (!row?.active) return 'revoked'
  if (row.last_error) return 'error'
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at)
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= new Date(now).getTime()) return 'reconnect_required'
  }
  return 'connected'
}

// Canonical, secret-free representation returned to clients. Provider tables
// remain authoritative during the additive migration to this domain model.
export function toChannelConnection(row, provider, now = new Date()) {
  return {
    id: row.id,
    projectId: row.project_id,
    provider,
    status: connectionStatus(row, now),
    reconnectRequired: connectionStatus(row, now) === 'reconnect_required',
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    capabilities: connectionCapabilities(provider),
    lastVerifiedAt: row.last_verified_at || null,
    error: row.last_error ? { code: row.last_error_code || 'PROVIDER_ERROR', message: 'Provider connection requires attention' } : null,
    createdAt: row.created_at || null,
  }
}

