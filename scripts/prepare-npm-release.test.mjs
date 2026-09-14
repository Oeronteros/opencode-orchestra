import assert from 'node:assert/strict'
import test from 'node:test'
import { nextVersion } from './prepare-npm-release.mjs'

test('increments the highest reserved or published stable version', () => {
  assert.equal(nextVersion('2.0.3', ['2.0.3', '2.0.4']), '2.0.5')
  assert.equal(nextVersion('2.0.3', ['2.0.9', '2.0.10']), '2.0.11')
  assert.equal(nextVersion('2.0.3', ['2.1.0', '3.0.0-beta.1']), '2.1.1')
})
test('honors a manually increased version and handles the first publication', () => {
  assert.equal(nextVersion('3.0.0', ['2.0.3']), '3.0.0')
  assert.equal(nextVersion('2.0.3', []), '2.0.3')
  assert.throws(() => nextVersion('invalid', []))
})
