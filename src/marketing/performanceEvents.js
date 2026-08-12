import crypto from 'node:crypto'

export const PERFORMANCE_EVENT_SCHEMA_VERSION = 1
const allowedKinds = new Set(['impression', 'click', 'conversion', 'publish_succeeded', 'publish_failed'])

export function createPerformanceEvent(input, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  if (!input.userId || !input.projectId || !input.campaignId) throw new Error('userId, projectId and campaignId are required')
  if (!allowedKinds.has(input.kind)) throw new Error('Unsupported performance event kind')
  if (!input.source?.provider || !input.source?.externalEventId) throw new Error('provider and externalEventId are required')
  return { id, schemaVersion: PERFORMANCE_EVENT_SCHEMA_VERSION, userId: input.userId, projectId: input.projectId, campaignId: input.campaignId, artifactId: input.artifactId || null, kind: input.kind, value: input.value == null ? 1 : Number(input.value), unit: input.unit || 'count', occurredAt: input.occurredAt || now, receivedAt: now, source: { provider: input.source.provider, externalEventId: input.source.externalEventId }, metadata: input.metadata || {} }
}

export function summarizePerformance(events) {
  const totals = {}; for (const event of events) { const key = `${event.kind}:${event.unit}`; totals[key] = (totals[key] || 0) + event.value }
  return { schemaVersion: 1, observedEventCount: events.length, totals, derivedMetrics: {}, note: 'Only observed provider events are reported; no metrics are estimated or fabricated.' }
}

export async function recordPerformanceEvent(input, { db, id, now } = {}) {
  const event = createPerformanceEvent(input, { id, now })
  const { rows } = await db.query(`INSERT INTO marketing_performance_events (id,schema_version,user_id,project_id,campaign_id,artifact_id,kind,value,unit,occurred_at,received_at,source,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (user_id,project_id,(source->>'provider'),(source->>'externalEventId')) DO NOTHING RETURNING *`, [event.id,event.schemaVersion,event.userId,event.projectId,event.campaignId,event.artifactId,event.kind,event.value,event.unit,event.occurredAt,event.receivedAt,JSON.stringify(event.source),JSON.stringify(event.metadata)])
  return rows[0] || null
}
