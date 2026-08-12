const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const TRANSITIONS = Object.freeze({ planned: ['running', 'cancelled'], running: ['completed', 'failed', 'cancelled'], failed: ['running', 'cancelled'], completed: [], cancelled: [] })

export class ExecutionGraphError extends Error { constructor(code, message) { super(message); this.code = code } }

export function runnableSteps(plan) {
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

export function resumeExecution(plan) { return Object.freeze({ planId: plan.id, projectId: plan.projectId, runnable: runnableSteps(plan).map(step => step.id), completed: plan.steps.filter(step => step.status === 'completed').map(step => step.id) }) }

