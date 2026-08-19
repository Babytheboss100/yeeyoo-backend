import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assertDefaultVideoExecutionAvailable } from '../src/mediaEngine/providers/videoExecutionPolicy.js'

const route = fs.readFileSync(new URL('../src/routes/media-jobs.js', import.meta.url), 'utf8')
const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

test('media job route is mounted once at the frozen v1 path', () => {
  assert.equal((index.match(/app\.use\('\/api\/media\/v1\/jobs', mediaJobRoutes\)/g) || []).length, 1)
})

test('every media job route is behind canonical auth and project ownership', () => {
  assert.match(route, /router\.use\(authMiddleware\)/)
  assert.match(route, /router\.post\('\/'/)
  assert.match(route, /router\.get\('\/:id'/)
  assert.match(route, /router\.get\('\/:id\/preview'/)
  assert.match(route, /router\.get\('\/assets\/:artifactId\/preview'/)
  assert.match(route, /router\.post\('\/:id\/artifact'/)
  assert.match(route, /router\.post\('\/:id\/cancel'/)
  assert.equal((route.match(/await requireProjectImpl\(/g) || []).length, 6)
  assert.match(route, /router\.post\('\/', createLimiter,/)
  assert.doesNotMatch(route, /router\.get\('\/:id', createLimiter,/)
})

test('Phase A must be explicitly enabled and responses remain truthful about mock execution', () => {
  assert.match(route, /MEDIA_ENGINE_PHASE_A_ENABLED === 'true'/)
  assert.match(route, /MEDIA_ENGINE_PHASE_A_DISABLED/)
  assert.match(route, /function executionDisclosure\(job\)/)
  assert.match(route, /providerActionTaken: composer, mock: !composer/)
  assert.equal((route.match(/\.\.\.executionDisclosure\(/g) || []).length, 3)
})

test('PostgreSQL JobStore is selected only by explicit env and an injected canonical pool', () => {
  assert.match(route, /MEDIA_JOB_STORE !== 'postgres'/)
  assert.match(route, /createPostgresMediaJobStore\(\{ db: postgresPool \}\)/)
  assert.match(route, /MEDIA_JOB_STORE=postgres requires the injected canonical PostgreSQL pool/)
  assert.match(index, /createDefaultMediaJobService\(\{ env: process\.env, postgresPool: pool \}\)/)
  assert.match(index, /createMediaJobsRouter\(\{ env: process\.env, postgresPool: pool, service: mediaJobService \}\)/)
  assert.doesNotMatch(route, /from ['"]\.\.\/db\.js['"]/)
})

test('PostgreSQL mode fails closed before process-local video submission', () => {
  assert.throws(
    () => assertDefaultVideoExecutionAvailable({
      env: { MEDIA_JOB_STORE: 'postgres' },
      input: { operation: 'video.render' },
    }),
    (error) => error?.code === 'VIDEO_DURABLE_RUNNER_REQUIRED' && error?.status === 503,
  )
  assert.doesNotThrow(() => assertDefaultVideoExecutionAvailable({
    env: { MEDIA_JOB_STORE: 'postgres' },
    input: { operation: 'image.generate' },
  }))
  assert.doesNotThrow(() => assertDefaultVideoExecutionAvailable({
    env: { MEDIA_JOB_STORE: 'memory' },
    input: { operation: 'video.render' },
  }))
  assert.doesNotThrow(() => assertDefaultVideoExecutionAvailable({
    env: { MEDIA_JOB_STORE: 'postgres', MEDIA_VIDEO_LEASE_RUNNER_ENABLED: 'true' },
    input: { operation: 'video.render' },
  }))
  assert.doesNotThrow(() => assertDefaultVideoExecutionAvailable({
    env: { MEDIA_JOB_STORE: 'postgres', MEDIA_VIDEO_RUNNER_MODE: 'standalone' },
    input: { operation: 'video.render' },
  }))

  assert.match(route, /deferredOperations: env\.MEDIA_JOB_STORE === 'postgres' \? \[VIDEO_RENDER_OPERATION\] : \[\]/)
  assert.match(route, /assertDefaultVideoExecutionAvailable\(\{ env, input: req\.body \}\)/)
})
