import test from 'node:test'
import assert from 'node:assert/strict'
import { assertObservedEvents, buildObservedLearning } from '../src/marketing/learningLoop.js'
test('learning loop reports observed totals and never infers causation',()=>{const events=[{kind:'click',unit:'count',value:3,channel:'linkedin',artifactId:'a1',source:{provider:'mock'},occurredAt:'2026-01-01T00:00:00Z'}];assertObservedEvents(events);const result=buildObservedLearning(events);assert.equal(result.breakdown[0].observations['click:count'],3);assert.deepEqual(result.hypotheses,[]);assert.match(result.disclaimer,/not proof of causation/i)})
test('learning loop rejects events without provenance',()=>assert.throws(()=>assertObservedEvents([{kind:'click'}]),/source and timestamp provenance/))
