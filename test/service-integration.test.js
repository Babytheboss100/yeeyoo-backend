import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { publishPost } from '../src/publishing/service.js'
import { rotateSession } from '../src/lib/session.js'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

function publishingDb(initialPost) {
  const state = {
    post: { ...initialPost },
    attempt: null,
    streakEvents: new Set(),
    user: { streak_count: 0, last_post_at: null },
    transactions: [],
  }
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) {
        state.transactions.push(normalized)
        return { rows: [] }
      }
      if (normalized.startsWith('SELECT p.*, EXISTS(')) {
        return { rows: state.post.id === params[0] && state.post.user_id === params[1] ? [{ ...state.post, approval_current: true }] : [] }
      }
      if (normalized.startsWith('SELECT * FROM publish_attempts')) {
        return { rows: state.attempt?.idempotency_key === params[0] ? [{ ...state.attempt }] : [] }
      }
      if (normalized.startsWith('INSERT INTO publish_attempts')) {
        state.attempt = { id: params[0], user_id: params[1], project_id: params[2], post_id: params[3], adapter: params[4], idempotency_key: params[5], status: 'running' }
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO project_activity') || normalized.startsWith('INSERT INTO marketing_performance_events')) {
        return { rows: [{}] }
      }
      if (normalized.startsWith("UPDATE posts SET status='published'")) {
        state.post = { ...state.post, status: 'published', published_at: params[0] }
        return { rows: [{ ...state.post }] }
      }
      if (normalized.startsWith("UPDATE posts SET status='publish_failed'")) {
        state.post.status = 'publish_failed'
        return { rows: [] }
      }
      if (normalized.startsWith("UPDATE publish_attempts SET status='published'")) {
        Object.assign(state.attempt, { status: 'published', provider_result: params[0] })
        return { rows: [] }
      }
      if (normalized.startsWith("UPDATE publish_attempts SET status='failed'")) {
        Object.assign(state.attempt, { status: 'failed', error: params[0] })
        return { rows: [] }
      }
      if (normalized.startsWith('INSERT INTO streak_events')) {
        if (state.streakEvents.has(params[1])) return { rows: [] }
        state.streakEvents.add(params[1])
        return { rows: [{ id: 'event-1' }] }
      }
      if (normalized.startsWith('SELECT streak_count,last_post_at FROM users')) return { rows: [{ ...state.user }] }
      if (normalized.startsWith('UPDATE users SET streak_count=')) {
        state.user = { streak_count: params[0], last_post_at: params[1] }
        return { rows: [] }
      }
      throw new Error(`Unexpected SQL: ${normalized}`)
    },
    release() {},
  }
  return { db: { connect: async () => client }, state }
}

test('approved post completes publish transaction and idempotently bumps streak once', async () => {
  const scope = { projectId: 'project-1', campaignId: 'campaign-1', artifactId: 'artifact-1', artifactVersion: 1, idempotencyKey: 'publish-post-1' }
  const { db, state } = publishingDb({ id: 'post-1', user_id: 'user-1', project_id: scope.projectId, campaign_id: scope.campaignId, artifact_id: scope.artifactId, artifact_version: scope.artifactVersion, status: 'approved' })
  let providerCalls = 0
  const adapter = { id: 'local-test', publish: async () => { providerCalls += 1; return { externalId: 'local-1' } } }
  const occurredAt = new Date('2026-08-12T10:00:00Z')

  const first = await publishPost({ userId: 'user-1', postId: 'post-1', ...scope, adapter, db, now: occurredAt })
  const second = await publishPost({ userId: 'user-1', postId: 'post-1', ...scope, adapter, db, now: occurredAt })

  assert.equal(first.status, 200)
  assert.equal(first.body.idempotent, false)
  assert.equal(second.body.idempotent, true)
  assert.equal(providerCalls, 1)
  assert.equal(state.post.status, 'published')
  assert.equal(state.attempt.status, 'published')
  assert.deepEqual([...state.streakEvents], ['publish:post-1'])
  assert.equal(state.user.streak_count, 1)
})

test('failed publish commits a retryable failure without bumping streak', async () => {
  const scope = { projectId: 'project-1', campaignId: 'campaign-1', artifactId: 'artifact-1', artifactVersion: 1, idempotencyKey: 'publish-post-2' }
  const { db, state } = publishingDb({ id: 'post-2', user_id: 'user-1', project_id: scope.projectId, campaign_id: scope.campaignId, artifact_id: scope.artifactId, artifact_version: scope.artifactVersion, status: 'approved' })
  const adapter = { id: 'local-test', publish: async () => { throw new Error('provider unavailable') } }

  const result = await publishPost({ userId: 'user-1', postId: 'post-2', ...scope, adapter, db })

  assert.equal(result.status, 502)
  assert.equal(result.body.code, 'PUBLISH_FAILED')
  assert.equal(state.post.status, 'publish_failed')
  assert.equal(state.attempt.status, 'failed')
  assert.equal(state.streakEvents.size, 0)
  assert.ok(state.transactions.includes('COMMIT'))
})

function rotationDb(session) {
  const state = { current: { ...session }, inserted: null, familyRevoked: false, transaction: [] }
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) { state.transaction.push(normalized); return { rows: [] } }
      if (normalized.startsWith('SELECT * FROM auth_sessions')) return { rows: state.current.refresh_hash === params[0] ? [{ ...state.current }] : [] }
      if (normalized.startsWith('UPDATE auth_sessions SET revoked_at=COALESCE')) { state.familyRevoked = true; return { rows: [] } }
      if (normalized.startsWith('UPDATE auth_sessions SET revoked_at=NOW()')) { state.current.revoked_at = new Date(); return { rows: [] } }
      if (normalized.startsWith('INSERT INTO auth_sessions')) { state.inserted = { refresh_hash: params[3], family_id: params[4] }; return { rows: [] } }
      if (normalized.startsWith('UPDATE auth_sessions SET family_id=')) { state.inserted.family_id = params[0]; return { rows: [] } }
      throw new Error(`Unexpected SQL: ${normalized}`)
    },
    release() {},
  }
  return { db: { connect: async () => client }, state }
}

test('refresh rotation revokes the old token and preserves its session family', async () => {
  const oldToken = 'old-refresh-token'
  const familyId = 'family-1'
  const { db, state } = rotationDb({ id: 'session-1', user_id: 'user-1', refresh_hash: sha256(oldToken), family_id: familyId, revoked_at: null, refresh_expires_at: new Date(Date.now() + 60_000) })

  const next = await rotateSession(oldToken, { headers: {}, ip: '127.0.0.1' }, db)

  assert.ok(next?.accessToken)
  assert.ok(next?.refreshToken)
  assert.ok(state.current.revoked_at)
  assert.equal(state.inserted.family_id, familyId)
  assert.deepEqual(state.transaction, ['BEGIN', 'COMMIT'])
})

test('replayed refresh token revokes the entire session family', async () => {
  const reusedToken = 'reused-refresh-token'
  const { db, state } = rotationDb({ id: 'session-1', user_id: 'user-1', refresh_hash: sha256(reusedToken), family_id: 'family-1', revoked_at: new Date(), refresh_expires_at: new Date(Date.now() + 60_000) })

  assert.equal(await rotateSession(reusedToken, { headers: {}, ip: '127.0.0.1' }, db), null)
  assert.equal(state.familyRevoked, true)
  assert.deepEqual(state.transaction, ['BEGIN', 'COMMIT'])
})
