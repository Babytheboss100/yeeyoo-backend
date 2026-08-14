import crypto from 'crypto'
import { pool } from '../db.js'
import { calculateModelCost } from '../lib/aiPricing.js'

const STATUS = new Set(['reserved', 'succeeded', 'failed', 'throttled', 'cancelled'])
const PERIOD_SQL = { day: "INTERVAL '1 day'", month: "INTERVAL '1 month'" }

const requiredText = (value, name) => {
  const normalized = String(value || '').trim()
  if (!normalized) throw new TypeError(`${name} is required`)
  return normalized
}

export async function recordAIUsage(input, { db = pool, pricingTable } = {}) {
  const userId = requiredText(input.userId, 'userId')
  const operation = requiredText(input.operation, 'operation')
  const provider = requiredText(input.provider, 'provider').toLowerCase()
  const model = requiredText(input.model, 'model').toLowerCase()
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey')
  const attempt = Number(input.attempt ?? 1)
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive integer')
  const status = input.status || 'succeeded'
  if (!STATUS.has(status)) throw new TypeError('Invalid AI usage status')
  const inputTokens = Number(input.inputTokens ?? 0), outputTokens = Number(input.outputTokens ?? 0), cachedInputTokens = Number(input.cachedInputTokens ?? 0)
  const billable = input.billable ?? status === 'succeeded'
  const calculated = billable
    ? calculateModelCost({ provider, model, inputTokens, outputTokens, cachedInputTokens, table: pricingTable })
    : { costUsd: 0, pricingVersion: 'non-billable-v1' }
  const providerCost = input.providerCostUsd == null ? null : Number(input.providerCostUsd)
  if (providerCost != null && (!Number.isFinite(providerCost) || providerCost < 0)) throw new TypeError('providerCostUsd must be non-negative')
  const finalCost = billable ? (providerCost ?? calculated.costUsd) : 0
  const costSource = !billable ? 'non_billable' : providerCost == null ? 'estimated' : 'provider_reported'
  const mediaUnits = Number(input.mediaUnits ?? 0)
  if (!Number.isFinite(mediaUnits) || mediaUnits < 0) throw new TypeError('mediaUnits must be non-negative')
  const values = [crypto.randomUUID(), userId, input.projectId || null, input.campaignId || null, input.planId || null,
    input.planStepId || null, input.jobId || null, input.specialist || null, operation, provider, model, idempotencyKey,
    attempt, status, inputTokens, outputTokens, cachedInputTokens, mediaUnits, input.mediaUnitType || null, finalCost,
    calculated.costUsd, providerCost, costSource, Boolean(billable), input.retryOf || null, calculated.pricingVersion,
    JSON.stringify(input.metadata || {})]
  const { rows } = await db.query(`INSERT INTO ai_usage_ledger
    (id,user_id,project_id,campaign_id,plan_id,plan_step_id,job_id,specialist,operation,provider,model,idempotency_key,
     attempt,status,input_tokens,output_tokens,cached_input_tokens,media_units,media_unit_type,cost_usd,estimated_cost_usd,
     provider_cost_usd,cost_source,billable,retry_of,pricing_version,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
    ON CONFLICT ON CONSTRAINT ai_usage_ledger_attempt_unique DO NOTHING RETURNING *`, values)
  if (rows[0]) return { row: rows[0], duplicate: false }
  const existing = await db.query(`SELECT * FROM ai_usage_ledger WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2
    AND operation=$3 AND idempotency_key=$4 AND attempt=$5`, [userId, input.projectId || null, operation, idempotencyKey, attempt])
  return { row: existing.rows[0], duplicate: true }
}

export async function getAIUsageSummary({ userId, projectId = null, from, to }, { db = pool } = {}) {
  requiredText(userId, 'userId')
  const values = [userId, projectId]
  let time = ''
  if (from) { values.push(from); time += ` AND created_at >= $${values.length}` }
  if (to) { values.push(to); time += ` AND created_at <= $${values.length}` }
  const { rows } = await db.query(`SELECT provider,model,operation,
    COUNT(*)::int AS attempts,
    COUNT(*) FILTER (WHERE status='succeeded')::int AS succeeded,
    COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
    COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
    COALESCE(SUM(cost_usd) FILTER (WHERE billable),0)::numeric AS cost_usd
    FROM ai_usage_ledger WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2${time}
    GROUP BY provider,model,operation ORDER BY cost_usd DESC`, values)
  return rows
}

export async function getAdminUsageSummary({ from, to } = {}, { db = pool } = {}) {
  const values = []; let time = ''
  if (from) { values.push(from); time += ` AND created_at >= $${values.length}` }
  if (to) { values.push(to); time += ` AND created_at <= $${values.length}` }
  const dimensions = {
    byProvider: 'provider', byModel: 'model', bySpecialist: 'specialist', byProject: 'project_id',
    byCampaign: 'campaign_id', byPlan: 'plan_id', byJob: 'job_id', byTenant: 'user_id',
  }
  const result = {}
  const total = await db.query(`SELECT COUNT(*)::int AS attempts,COALESCE(SUM(cost_usd) FILTER(WHERE billable),0)::numeric AS cost_usd,
    COALESCE(SUM(cost_usd) FILTER(WHERE billable AND created_at>=CURRENT_DATE),0)::numeric AS cost_today,
    COALESCE(SUM(cost_usd) FILTER(WHERE billable AND created_at>=date_trunc('month',NOW())),0)::numeric AS cost_this_month,
    COALESCE(AVG(cost_usd) FILTER(WHERE billable AND status='succeeded'),0)::numeric AS average_successful_job_cost,
    COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,COALESCE(SUM(output_tokens),0)::bigint AS output_tokens
    FROM ai_usage_ledger WHERE TRUE${time}`, values)
  result.summary = total.rows[0]
  for (const [name, column] of Object.entries(dimensions)) {
    const { rows } = await db.query(`SELECT ${column} AS dimension,COUNT(*)::int AS attempts,
      COALESCE(SUM(cost_usd) FILTER(WHERE billable),0)::numeric AS cost_usd FROM ai_usage_ledger
      WHERE TRUE${time} GROUP BY ${column} ORDER BY cost_usd DESC`, values)
    result[name] = rows
  }
  const customer = await db.query(`WITH customer_cost AS (
      SELECT user_id,SUM(cost_usd) FILTER(WHERE billable) AS cost FROM ai_usage_ledger WHERE TRUE${time} GROUP BY user_id
    ) SELECT COUNT(*)::int AS active_customers,COALESCE(AVG(cost),0)::numeric AS average_cost_per_active_customer,
      COALESCE(percentile_cont(0.5) WITHIN GROUP(ORDER BY cost),0)::numeric AS median_customer_cost,
      COALESCE(MAX(cost),0)::numeric AS heavy_user_cost FROM customer_cost`, values)
  const campaignTime = time.replaceAll('created_at', 'l.created_at')
  const campaign = await db.query(`SELECT CASE WHEN COUNT(DISTINCT c.id)>0
      THEN COALESCE(SUM(l.cost_usd) FILTER(WHERE l.billable),0)/COUNT(DISTINCT c.id)
      ELSE NULL END AS cost_per_completed_campaign FROM ai_usage_ledger l
      JOIN marketing_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id AND c.project_id=l.project_id
      WHERE c.status='completed'${campaignTime}`, values)
  const summary = result.summary || {}
  return { ...result, summary: { ...summary, costToday: summary.cost_today, costThisMonth: summary.cost_this_month,
      averageSuccessfulJobCost: summary.average_successful_job_cost },
    scenarios: { ...customer.rows[0], costPerCompletedCampaign: campaign.rows[0]?.cost_per_completed_campaign },
    currency: 'USD', generatedAt: new Date().toISOString(), providerReportedAndEstimatedSeparated: true }
}

export async function checkCostAllowance({ userId, projectId = null, campaignId = null, planId = null, jobId = null, estimatedCostUsd = 0 }, { db = pool } = {}) {
  requiredText(userId, 'userId')
  const estimate = Number(estimatedCostUsd)
  if (!Number.isFinite(estimate) || estimate < 0) throw new TypeError('estimatedCostUsd must be non-negative')
  const { rows } = await db.query(`SELECT a.period,a.ceiling_usd,
    COALESCE(SUM(l.cost_usd) FILTER (WHERE l.billable AND (a.period IN ('job','plan') OR
      l.created_at >= CASE a.period WHEN 'day' THEN NOW()-INTERVAL '1 day' ELSE NOW()-INTERVAL '1 month' END)),0) AS used_usd
    FROM ai_cost_allowances a LEFT JOIN ai_usage_ledger l ON l.user_id=a.user_id
      AND l.project_id IS NOT DISTINCT FROM a.project_id AND l.campaign_id IS NOT DISTINCT FROM a.campaign_id
      AND l.plan_id IS NOT DISTINCT FROM a.plan_id AND l.job_id IS NOT DISTINCT FROM a.job_id
    WHERE a.user_id=$1 AND a.project_id IS NOT DISTINCT FROM $2 AND a.campaign_id IS NOT DISTINCT FROM $3
      AND a.plan_id IS NOT DISTINCT FROM $4 AND a.job_id IS NOT DISTINCT FROM $5 AND a.enabled=TRUE
    GROUP BY a.period,a.ceiling_usd`, [userId, projectId, campaignId, planId, jobId])
  const exceeded = rows.find(row => Number(row.used_usd) + estimate > Number(row.ceiling_usd))
  return exceeded ? { allowed: false, code: 'AI_COST_CEILING_EXCEEDED', period: exceeded.period, ceilingUsd: Number(exceeded.ceiling_usd), usedUsd: Number(exceeded.used_usd) }
    : { allowed: true }
}
