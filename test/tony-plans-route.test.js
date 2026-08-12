import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source=fs.readFileSync(new URL('../src/routes/tony-plans.js',import.meta.url),'utf8')
test('Tony plan endpoints require auth and project ownership globally',()=>{assert.match(source,/r\.use\(auth\)/);assert.match(source,/r\.use\(enforceProjectOwnership\)/)})
test('safe resume is advisory and never claims execution',()=>{assert.match(source,/executionStarted: false/);assert.doesNotMatch(source,/transitionStep\(/)})
test('Autopilot policy route cannot bind budget, channels or approval from UI',()=>{assert.match(source,/VALUES \(\$1,\$2,\$3,\$4,'\[\]',NULL,NULL,\$5\)/);assert.match(source,/requiresBoundApproval/)})
