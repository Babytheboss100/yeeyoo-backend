import test from 'node:test'
import assert from 'node:assert/strict'
import { requireProject, ProjectAccessError } from '../src/middleware/project.js'

test('requireProject returns an owned project', async () => {
  const db = { query: async (sql, params) => ({ rows: params[0] === 'p1' && params[1] === 'u1' ? [{ id: 'p1', user_id: 'u1' }] : [] }) }
  assert.equal((await requireProject({ user: { id: 'u1' } }, 'p1', db)).id, 'p1')
})

test('requireProject denies cross-user project access without disclosure', async () => {
  const db = { query: async () => ({ rows: [] }) }
  await assert.rejects(requireProject({ user: { id: 'u2' } }, 'p1', db), (error) => error instanceof ProjectAccessError && error.status === 404 && error.code === 'PROJECT_NOT_FOUND')
})
