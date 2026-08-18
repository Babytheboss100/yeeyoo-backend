import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The /voice/turn catch block is the last thing between a raw driver error and
// the client. It is not reachable from a unit test without a live pool, so the
// shipped lines themselves are lifted out of the route and executed here: this
// asserts the real source, not a copy of it that could drift.
const routeSource = fs.readFileSync(new URL('../src/routes/voice-agent.js', import.meta.url), 'utf8')
const shaping = routeSource.match(/const status = Number\(error\.status\)[\s\S]*?code \}\)/)
assert.ok(shaping, 'the /voice/turn error shaping could not be located in the route source')
const shapeError = new Function('error', 'res', shaping[0])

function capture(error) {
  const sent = {}
  shapeError(error, { status(code) { sent.status = code; return this }, json(body) { sent.body = body; return this } })
  return sent
}

test('an unexpected error carries neither its status nor its message to the client', () => {
  // What a CHECK violation actually looks like coming out of pg: no status, and
  // a message naming the relation and the constraint that rejected the write.
  const pgError = Object.assign(
    new Error('new row for relation "project_activity" violates check constraint "project_activity_event_type_check"'),
    { code: '23514', severity: 'ERROR', table: 'project_activity', constraint: 'project_activity_event_type_check', routine: 'ExecConstraints' },
  )
  const sent = capture(pgError)
  assert.equal(sent.status, 500, 'a driver error must not be reported as a client mistake')
  assert.equal(sent.body.error, 'Voice turn failed')
  const serialized = JSON.stringify(sent.body).toLowerCase()
  assert.doesNotMatch(serialized, /constraint/)
  assert.doesNotMatch(serialized, /relation/)
  assert.doesNotMatch(serialized, /project_activity|23514|execconstraints/)

  // A bare error is the same case: nothing the route did not shape may speak.
  const bare = capture(new Error('connect ECONNREFUSED 10.0.0.4:5432'))
  assert.equal(bare.status, 500)
  assert.equal(bare.body.error, 'Voice turn failed')
  assert.doesNotMatch(JSON.stringify(bare.body), /5432|ECONNREFUSED/)
})

test('errors the route shaped itself still reach the caller intact', () => {
  const notFound = capture(Object.assign(new Error('Sosy voice uses canonical project activity'), { code: 'VOICE_CONVERSATION_NOT_FOUND', status: 404 }))
  assert.equal(notFound.status, 404)
  assert.equal(notFound.body.error, 'Sosy voice uses canonical project activity')
  assert.equal(notFound.body.code, 'VOICE_CONVERSATION_NOT_FOUND')

  // A deliberate 5xx is still a server fault: the code survives, the text does not.
  const upstream = capture(Object.assign(new Error('vendor said sk-live-abc is revoked'), { code: 'VOICE_PROVIDER_FAILED', status: 502 }))
  assert.equal(upstream.status, 500)
  assert.equal(upstream.body.error, 'Voice turn failed')
  assert.equal(upstream.body.code, 'VOICE_PROVIDER_FAILED')
  assert.doesNotMatch(JSON.stringify(upstream.body), /sk-live/)

  // A non-numeric or absurd status cannot be laundered into a 4xx.
  for (const status of ['400', NaN, 0, 399, 400.5, 600, null]) {
    const shaped = capture(Object.assign(new Error('leak me'), { status }))
    if (status === '400') continue
    assert.equal(shaped.status, 500, `status ${String(status)} must not open the message path`)
    assert.equal(shaped.body.error, 'Voice turn failed')
  }
})

test('the leaky default is gone from the route', () => {
  // `Number(error.status) || 400` turned every statusless error into a 400 that
  // returned error.message verbatim. It must not come back.
  assert.doesNotMatch(routeSource, /Number\(error\.status\) \|\| 400/)
  assert.match(routeSource, /Number\.isInteger\(status\) && status >= 400 && status < 500/)
})
