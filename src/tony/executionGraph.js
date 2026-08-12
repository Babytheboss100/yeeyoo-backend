const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const TRANSITIONS = Object.freeze({ planned: ['running', 'cancelled'], running: ['completed', 'failed', 'cancelled'], failed: ['running', 'cancelled'], completed: [], cancelled: [] })

export class ExecutionGraphError extends Error { constructor(code, message) { super(message); this.code = code } }

export function assertExecutionGraph(plan, expectedProjectId = null) {
  if (!plan || !plan.id || !plan.projectId || !Array.isArray(plan.steps)) throw new ExecutionGraphError('INVALID_EXECUTION_GRAPH', 'Execution graph is malformed')
  if (expectedProjectId && plan.projectId !== expectedProjectId) throw new ExecutionGraphError('CROSS_PROJECT_EXECUTION_GRAPH', 'Execution graph belongs to another project')
  const ids = new Set(plan.steps.map(step => step?.id))
  if (ids.size !== plan.steps.length || ids.has(undefined)) throw new ExecutionGraphError('INVALID_EXECUTION_GRAPH', 'Execution step identifiers must be unique')
  for (const step of plan.steps) {
    if (!Array.isArray(step.dependencies) || step.dependencies.some(id => !ids.has(id) || id === step.id)) throw new ExecutionGraphError('INVALID_EXECUTION_GRAPH', 'Execution dependencies are invalid')
  }
  const visiting = new Set(), visited = new Set(), byId = new Map(plan.steps.map(step => [step.id, step]))
  const visit = id => { if (visiting.has(id)) throw new ExecutionGraphError('INVALID_EXECUTION_GRAPH', 'Execution graph contains a dependency cycle'); if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id).dependencies) visit(dependency); visiting.delete(id); visited.add(id) }
  for (const id of ids) visit(id)
  return plan
}

export function runnableSteps(plan) {
  assertExecutionGraph(plan)
  const byId = new Map(plan.steps.map(step => [step.id, step]))
  return plan.steps.filter(step => (step.status === 'planned' || step.status === 'failed') && step.dependencies.every(id => byId.get(id)?.status === 'completed'))
}

export function transitionStep(plan, { stepId, from, to, idempotencyKey, aiJobId = null, outputArtifactIds = [], error = null, now = () => new Date().toISOString() }) {
  if (!idempotencyKey) throw new ExecutionGraphError('IDEMPOTENCY_KEY_REQUIRED', 'Execution steps require an idempotency key')
  const index = plan.steps.findIndex(step => step.id === stepId)
  if (index < 0) throw new ExecutionGraphError('STEP_NOT_FOUND', 'Execution step was not found')
  const current = plan.steps[index]
  if (current.lastIdempotencyKey === idempotencyKey) return plan
  if (current.status !== from) throw new ExecutionGraphError('STALE_STEP_STATE', 'Execution step state changed')
  if (!TRANSITIONS[from]?.includes(to)) throw new ExecutionGraphError('INVALID_STEP_TRANSITION', `Cannot transition ${from} to ${to}`)
  if (to === 'running' && !runnableSteps(plan).some(step => step.id === stepId)) throw new ExecutionGraphError('DEPENDENCY_INCOMPLETE', 'Step dependencies are incomplete')
  const timestamp = now()
  const next = { ...current, status: to, aiJobId: aiJobId || current.aiJobId, outputArtifactIds: [...new Set([...current.outputArtifactIds, ...outputArtifactIds])],
    error: to === 'failed' ? String(error || 'Execution failed').slice(0, 1000) : null, lastIdempotencyKey: idempotencyKey,
    startedAt: to === 'running' ? (current.startedAt || timestamp) : current.startedAt,
    completedAt: TERMINAL.has(to) ? timestamp : null }
  const steps = plan.steps.map((step, i) => i === index ? Object.freeze(next) : step)
  const status = steps.every(step => step.status === 'completed') ? 'completed' : steps.some(step => step.status === 'running') ? 'running' : steps.some(step => step.status === 'failed') ? 'failed' : plan.status
  return Object.freeze({ ...plan, status, steps, updatedAt: timestamp })
}

export function resumeExecution(plan, expectedProjectId = null) { assertExecutionGraph(plan, expectedProjectId); return Object.freeze({ planId: plan.id, projectId: plan.projectId, runnable: runnableSteps(plan).map(step => step.id), completed: plan.steps.filter(step => step.status === 'completed').map(step => step.id) }) }
