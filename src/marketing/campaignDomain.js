import crypto from 'node:crypto'

export const CAMPAIGN_SCHEMA_VERSION = 1
export const CAMPAIGN_STATUSES = Object.freeze(['draft', 'active', 'paused', 'completed', 'archived'])
const transitions = Object.freeze({ draft: ['active', 'archived'], active: ['paused', 'completed'], paused: ['active', 'completed', 'archived'], completed: ['archived'], archived: [] })

export function createCampaign(input, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  if (!input.userId || !input.projectId) throw new Error('userId and projectId are required')
  const name = String(input.name ?? '').trim(); if (!name) throw new Error('name is required')
  return { id, userId: input.userId, projectId: input.projectId, schemaVersion: CAMPAIGN_SCHEMA_VERSION, name, objective: String(input.objective ?? '').trim() || null, status: 'draft', createdAt: now, updatedAt: now }
}

export function transitionCampaign(campaign, to, now = new Date().toISOString()) {
  if (!campaign || !CAMPAIGN_STATUSES.includes(to) || !transitions[campaign.status]?.includes(to)) { const error = new Error(`Invalid campaign transition ${campaign?.status} -> ${to}`); error.code = 'INVALID_TRANSITION'; throw error }
  return { ...campaign, status: to, updatedAt: now }
}

export async function getCampaign({ id, userId, projectId, db }) {
  const { rows } = await db.query('SELECT * FROM marketing_campaigns WHERE id=$1 AND user_id=$2 AND project_id=$3', [id, userId, projectId]); return rows[0] || null
}

export async function listCampaigns({ userId, projectId, db }) {
  const { rows } = await db.query('SELECT * FROM marketing_campaigns WHERE user_id=$1 AND project_id=$2 ORDER BY updated_at DESC', [userId, projectId]); return rows
}
