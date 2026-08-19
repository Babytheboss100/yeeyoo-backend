import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createGetMediaInsightsHandler, GENOME_INSIGHTS_SQL, getGenomeInsights, MediaInsightsError } from '../src/mediaEngine/genome/insights.js'

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('genome insights use one owner-scoped, read-only SQL aggregate', async () => {
  let call
  const db = {
    async query(sql, params) {
      call = { sql, params }
      return { rows: [
        { dimension: 'hook.type', dimension_value: 'question', kind: 'click', unit: 'count', event_count: 3, artifact_count: 2, total_value: 9, average_value: 3, minimum_value: 1, maximum_value: 5 },
        { dimension: 'format', dimension_value: 'reel', kind: 'view', unit: 'count', event_count: '4', artifact_count: '1', total_value: '40', average_value: '10', minimum_value: '4', maximum_value: '16' },
        { dimension: 'cta.type', dimension_value: 'book', kind: 'conversion', unit: 'count', event_count: 1, artifact_count: 1, total_value: 1, average_value: 1, minimum_value: 1, maximum_value: 1 },
        { dimension: 'visual.first_frame', dimension_value: 'face', kind: 'view', unit: 'count', event_count: 2, artifact_count: 1, total_value: 20, average_value: 10, minimum_value: 8, maximum_value: 12 },
      ] }
    },
  }

  const result = await getGenomeInsights({ userId: ' user-a ', projectId: ' project-a ', db })
  assert.deepEqual(call.params, ['user-a', 'project-a'])
  assert.equal(call.sql, GENOME_INSIGHTS_SQL)
  assert.match(call.sql, /FROM marketing_performance_events AS e/i)
  assert.match(call.sql, /INNER JOIN marketing_artifacts AS a/i)
  assert.match(call.sql, /a\.id = e\.artifact_id/i)
  assert.match(call.sql, /a\.user_id = e\.user_id/i)
  assert.match(call.sql, /a\.project_id = e\.project_id/i)
  assert.match(call.sql, /e\.user_id = \$1/i)
  assert.match(call.sql, /e\.project_id = \$2/i)
  assert.match(call.sql, /COUNT\(\*\)::integer/i)
  assert.match(call.sql, /SUM\(value\)::double precision/i)
  assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i)
  assert.equal(result.schemaVersion, 'yeeyoo.media.insights.v1')
  assert.equal(result.projectId, 'project-a')
  assert.equal(result.dimensions.hookType[0].value, 'question')
  assert.equal(result.dimensions.hookType[0].eventCount, 3)
  assert.equal(result.dimensions.format[0].totalValue, 40)
  assert.equal(result.dimensions.ctaType[0].kind, 'conversion')
  assert.equal(result.dimensions.visualFirstFrame[0].value, 'face')
})

test('genome insight validation fails closed before querying', async () => {
  let queries = 0
  const db = { query: async () => { queries += 1; return { rows: [] } } }
  await assert.rejects(
    getGenomeInsights({ userId: 'u1', projectId: ' ', db }),
    error => error instanceof MediaInsightsError && error.code === 'MEDIA_INSIGHTS_PROJECT_ID_REQUIRED',
  )
  assert.equal(queries, 0)
  await assert.rejects(
    getGenomeInsights({ userId: ' ', projectId: 'p1', db }),
    error => error instanceof MediaInsightsError && error.code === 'MEDIA_INSIGHTS_USER_ID_REQUIRED',
  )
  assert.equal(queries, 0)
})

test('route handler verifies project ownership and forwards the same injected db', async () => {
  const calls = []
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] } } }
  const requireProjectImpl = async (req, projectId, injectedDb) => {
    calls.push({ ownership: [req.user.id, projectId], injectedDb })
    return { id: projectId }
  }
  const handler = createGetMediaInsightsHandler({ db, requireProjectImpl, sendErrorImpl: (res, error) => res.status(500).json({ error: error.message }) })
  const res = response()
  await handler({ user: { id: 'u1' }, query: { projectId: 'p1' } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.projectId, 'p1')
  assert.deepEqual(calls[0].ownership, ['u1', 'p1'])
  assert.equal(calls[0].injectedDb, db)
  assert.deepEqual(calls[1].params, ['u1', 'p1'])
})

test('route contract is canonical-authenticated and contains no direct database singleton', () => {
  const source = fs.readFileSync(new URL('../src/routes/media-insights.js', import.meta.url), 'utf8')
  assert.match(source, /router\.use\(authMiddleware\)/)
  assert.match(source, /router\.get\('\/', createGetMediaInsightsHandler/)
  assert.match(source, /createGetMediaInsightsHandler\(\{ db, requireProjectImpl, sendErrorImpl: sendError \}\)/)
  assert.doesNotMatch(source, /from ['"]\.\.\/db\.js['"]/)
})
