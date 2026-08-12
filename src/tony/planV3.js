import crypto from 'node:crypto'
import { SPECIALIST_CAPABILITIES } from './specialistRegistry.js'

export const TONY_PLAN_VERSION = 3

const FLOW = Object.freeze([
  ['project', 'marketing_audit'], ['profile', 'marketing_audit'], ['brand', 'brand'],
  ['competitors', 'competitors'], ['campaign', 'launch'], ['positioning', 'brand'],
  ['funnel', 'funnel'], ['copy', 'copy'], ['social', 'social'], ['seo', 'seo'],
  ['email', 'copy'], ['ads', 'ads'], ['launch', 'launch'], ['calendar', 'social'],
])

const normalizeText = (value, max = 2000) => String(value ?? '').trim().slice(0, max)

// The graph shape and capabilities are server-owned. Objective text is data and
// can never select a tool, approval state, or execution permission.
export function createTonyPlanV3({ userId, projectId, objective, campaignId = null, budget = null, currency = null, now = () => new Date().toISOString(), id = crypto.randomUUID() }) {
  if (!userId || !projectId) throw Object.assign(new Error('Authenticated project context is required'), { code: 'PROJECT_CONTEXT_REQUIRED' })
  const safeObjective = normalizeText(objective)
  if (!safeObjective) throw Object.assign(new Error('Objective is required'), { code: 'OBJECTIVE_REQUIRED' })
  if (budget != null && (!Number.isFinite(Number(budget)) || Number(budget) < 0)) throw Object.assign(new Error('Budget must be a non-negative number'), { code: 'INVALID_BUDGET' })
  const createdAt = now()
  const steps = FLOW.map(([key, specialist], index) => {
    if (!SPECIALIST_CAPABILITIES[specialist]) throw new Error(`Unknown server specialist: ${specialist}`)
    return Object.freeze({
      id: `${id}:${key}`, key, specialist, capability: SPECIALIST_CAPABILITIES[specialist].at(-1),
      dependencies: index ? [`${id}:${FLOW[index - 1][0]}`] : [], status: 'planned',
      inputArtifactVersions: [], outputArtifactIds: [], aiJobId: null, error: null,
      approvalRequired: false, startedAt: null, completedAt: null,
    })
  })
  return Object.freeze({ id, schemaVersion: TONY_PLAN_VERSION, userId, projectId, campaignId, objective: safeObjective,
    budget: budget == null ? null : Number(budget), currency: normalizeText(currency, 8) || null,
    status: 'planned', createdAt, updatedAt: createdAt, steps })
}
