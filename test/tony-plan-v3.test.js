import test from 'node:test'
import assert from 'node:assert/strict'
import { createTonyPlanV3 } from '../src/tony/planV3.js'
import { resumeExecution, transitionStep } from '../src/tony/executionGraph.js'

test('Tony V3 creates one coherent server-owned specialist plan', () => {
  const plan = createTonyPlanV3({ userId:'u1', projectId:'p1', objective:'Launch in Norway', id:'plan1', now:()=> '2026-01-01T00:00:00.000Z' })
  assert.equal(plan.schemaVersion, 3); assert.equal(plan.steps.length, 14); assert.equal(plan.steps.at(-1).key, 'calendar')
  assert.ok(plan.steps.every(step => !/(publish|send|spend|connect|delete)/i.test(step.capability)))
})

test('execution graph resumes without rerunning completed idempotent steps', () => {
  let plan = createTonyPlanV3({ userId:'u1', projectId:'p1', objective:'x', id:'plan1' })
  const first = plan.steps[0].id
  plan = transitionStep(plan, { stepId:first, from:'planned', to:'running', idempotencyKey:'start' })
  plan = transitionStep(plan, { stepId:first, from:'running', to:'completed', idempotencyKey:'finish', outputArtifactIds:['a1'] })
  assert.strictEqual(transitionStep(plan, { stepId:first, from:'running', to:'completed', idempotencyKey:'finish' }), plan)
  const resumed = resumeExecution(plan)
  assert.deepEqual(resumed.completed, [first]); assert.deepEqual(resumed.runnable, [plan.steps[1].id])
})

