import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaign, transitionCampaign } from '../src/marketing/campaignDomain.js'
import { generateFunnel } from '../src/marketing/funnelAgent.js'
import { createLaunchPlan } from '../src/marketing/launchOrchestrator.js'
import { createPerformanceEvent, summarizePerformance } from '../src/marketing/performanceEvents.js'

test('campaign lifecycle is explicit and rejects invalid state jumps', () => {
  const campaign = createCampaign({ userId: 'u1', projectId: 'p1', name: 'Launch' }, { id: 'c1', now: '2026-01-01T00:00:00Z' })
  const planned = transitionCampaign(campaign, 'planned')
  assert.equal(transitionCampaign(planned, 'active').status, 'active')
  assert.throws(() => transitionCampaign(campaign, 'completed'), /Invalid campaign transition/)
})

test('funnel reuses copy and labels assumptions without fabricated metrics', () => {
  const funnel = generateFunnel({ objective: 'Generate leads', audience: 'Founders', offer: 'Audit' }, { profile: { version: 2, brand: { name: 'Yeeyoo' } } })
  assert.equal(funnel.provenance.generator, 'copyAgent.generateCopy')
  assert.deepEqual(funnel.metrics, [])
  assert.equal(funnel.executable, false)
})

test('launch rejects cross-project child artifacts and never executes', () => {
  assert.throws(() => createLaunchPlan({ userId: 'u1', projectId: 'p1', name: 'Launch' }, { artifacts: [{ id: 'a1', userId: 'u1', projectId: 'p2' }] }), error => error.code === 'PROJECT_ACCESS_DENIED')
  const launch = createLaunchPlan({ userId: 'u1', projectId: 'p1', name: 'Launch' }, { artifacts: [{ id: 'a1', userId: 'u1', projectId: 'p1', artifactVersion: 1, type: 'copy', status: 'draft' }] })
  assert.equal(launch.executable, false)
  assert.equal(launch.readiness[0].ready, false)
})

test('reporting contains only observed provider events and no inferred metrics', () => {
  const event = createPerformanceEvent({ userId: 'u1', projectId: 'p1', campaignId: 'c1', kind: 'click', value: 4, source: { provider: 'mock', externalEventId: 'e1' } }, { id: 'pe1', now: '2026-01-01T00:00:00Z' })
  const report = summarizePerformance([event])
  assert.equal(report.totals['click:count'], 4)
  assert.deepEqual(report.derivedMetrics, {})
  assert.match(report.note, /no metrics are estimated or fabricated/i)
})
