import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { checkAILimit } from '../src/middleware/aiLimit.js'

// SECURITY_AUDIT_2026-08-19.md HØY-3: video.js og inbox.js kalte betalte
// providere uten per-bruker-kvote, og video.js førte ingen kostnad.

const source = name => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

test('video og inbox har kvote i alle fire tiers', () => {
  const limits = source('middleware/aiLimit.js')
  const block = limits.slice(limits.indexOf('const LIMITS'), limits.indexOf('const WINDOW_SQL'))
  for (const tier of ['free', 'tier1', 'tier2', 'enterprise']) {
    const line = block.split('\n').find(l => l.trim().startsWith(`${tier}:`))
    assert.ok(line, `mangler tier ${tier}`)
    assert.match(line, /video: \{ limit: -?\d+/, `${tier} mangler video`)
    assert.match(line, /inbox: \{ limit: -?\d+/, `${tier} mangler inbox`)
  }
  // Free skal ikke kunne generere video; inbox-forslag følger tony_chat.
  const free = block.split('\n').find(l => l.trim().startsWith('free:'))
  assert.match(free, /video: \{ limit: 0,/)
  assert.match(free, /inbox: \{ limit: 5,/)
})

test('de betalte rutene er faktisk koblet til grensen', () => {
  const video = source('routes/video.js')
  assert.match(video, /r\.post\('\/generate', checkAILimit\('video'\)/)
  assert.match(video, /logAIUsage\(\{ userId: req\.user\.id, endpoint: 'video', cost: VIDEO_COST \}\)/)
  assert.match(video, /const VIDEO_COST = /)

  const inbox = source('routes/inbox.js')
  assert.match(inbox, /r\.post\('\/conversations\/:id\/suggest', checkAILimit\('inbox'\)/)
})

test('en ukjent endepunkttype faar nullkvote i regelverket', () => {
  // Dokumenterer den faktiske kontrakten: LIMITS-oppslaget faller tilbake til
  // { limit: 0 }, saa en rute som glemmer aa legge seg inn i LIMITS er stengt
  // for alle tiers - ikke fri. Det er grunnen til at video/inbox maatte legges
  // inn i tabellen og ikke bare faa checkAILimit paakoblet.
  const limits = source('middleware/aiLimit.js')
  assert.match(limits, /\|\| \{ limit: 0, window: '24h' \}/)
})

test('grensen haandheves kun naar databasen svarer', () => {
  // checkAILimit er bevisst fail-open ved DB-feil. Det er et villet valg, men
  // det betyr at kvotene fra denne fiksen ikke gjelder under en DB-hendelse.
  // Laast her saa endringen er synlig hvis noen snur den.
  const limits = source('middleware/aiLimit.js')
  assert.match(limits, /Fail-open/)
  assert.match(limits, /\[checkAILimit\] fail-open:/)
})
