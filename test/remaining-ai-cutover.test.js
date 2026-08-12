import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('remaining legacy AI routes create and transition canonical durable jobs', () => {
  for (const route of ['photoshoot.js', 'translateImage.js', 'seo.js', 'tony.js']) {
    const source = fs.readFileSync(new URL(`../src/routes/${route}`, import.meta.url), 'utf8')
    assert.match(source, /beginDurableJob/); assert.match(source, /transitionJob/); assert.match(source, /projectId kreves/)
  }
})
