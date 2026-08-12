import test from 'node:test'
import assert from 'node:assert/strict'
import { requireProject, ProjectAccessError } from '../src/middleware/project.js'
import { requireAdmin } from '../src/middleware/admin.js'

test('requireProject returns an owned project', async () => {
  const db = { query: async (sql, params) => ({ rows: params[0] === 'p1' && params[1] === 'u1' ? [{ id: 'p1', user_id: 'u1' }] : [] }) }
  assert.equal((await requireProject({ user: { id: 'u1' } }, 'p1', db)).id, 'p1')
})

test('requireProject denies cross-user project access without disclosure', async () => {
  const db = { query: async () => ({ rows: [] }) }
  await assert.rejects(requireProject({ user: { id: 'u2' } }, 'p1', db), (error) => error instanceof ProjectAccessError && error.status === 404 && error.code === 'PROJECT_NOT_FOUND')
})

test('requireProject normalizes project identifiers and rejects blank identifiers', async () => {
  let received
  const db = { query: async (_sql, params) => { received = params; return { rows: [{ id: params[0] }] } } }
  assert.equal((await requireProject({ user: { id: 'u1' } }, '  p1  ', db)).id, 'p1')
  assert.deepEqual(received, ['p1', 'u1'])
  await assert.rejects(
    requireProject({ user: { id: 'u1' } }, '   ', db),
    (error) => error instanceof ProjectAccessError && error.status === 400 && error.code === 'PROJECT_REQUIRED'
  )
})

test('requireAdmin prevents authenticated non-admin privilege escalation', () => {
  let status
  let payload
  const res = {
    status(value) { status = value; return this },
    json(value) { payload = value; return this },
  }
  let continued = false
  requireAdmin({ user: { id: 'u1', is_admin: false } }, res, () => { continued = true })
  assert.equal(status, 403)
  assert.equal(payload.code, 'ADMIN_REQUIRED')
  assert.equal(continued, false)

  requireAdmin({ user: { id: 'admin', is_admin: true } }, res, () => { continued = true })
  assert.equal(continued, true)
})
