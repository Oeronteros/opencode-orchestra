import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

for (const scenario of ['missing', 'existing', 'network', 'publish-failure']) {
  test(`publish voice: ${scenario}`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-publish-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@test/voice', version: '2.0.1' }))
      const fake = path.join(dir, 'npm.cjs')
      writeFileSync(fake, `
        const fs = require('node:fs');
        if (process.argv[2] === 'view') {
          if (process.env.SCENARIO === 'existing') { console.log(JSON.stringify('2.0.1')); }
          else { console.log(JSON.stringify({error: {code: process.env.SCENARIO === 'network' ? 'E503' : 'E404'}})); process.exitCode = 1; }
        } else {
          fs.writeFileSync('published', process.cwd());
          process.exitCode = process.env.SCENARIO === 'publish-failure' ? 1 : 0;
        }
      `)
      const result = spawnSync(process.execPath, ['scripts/publish-voice-package.mjs', dir], {
        env: { ...process.env, npm_execpath: fake, SCENARIO: scenario }, encoding: 'utf8',
      })
      assert.equal(result.status, ['network', 'publish-failure'].includes(scenario) ? 1 : 0, result.stderr)
      assert.equal(existsSync(path.join(dir, 'published')), ['missing', 'publish-failure'].includes(scenario))
      if (scenario === 'missing') assert.equal(readFileSync(path.join(dir, 'published'), 'utf8'), dir)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
