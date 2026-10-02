import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

assert.ok(process.argv[2], 'Usage: node scripts/verify-browser-package.mjs <temporary-install-root>')
const root = path.resolve(process.argv[2])
const packageRoot = path.join(root, 'node_modules/@oeronteros-1/opencode-orchestra')
const plugin = await import(pathToFileURL(path.join(packageRoot, 'dist/index.js')).href)
assert.equal(typeof plugin.server, 'function')
assert.equal(typeof plugin.default.setup, 'function')
const { backendEntry, backendCommand } = await import(pathToFileURL(path.join(packageRoot, 'dist/browser/packages.js')).href)
const { browserConfigSchema } = await import(pathToFileURL(path.join(packageRoot, 'dist/config/schema.js')).href)
for (const backend of ['playwright', 'devtools']) {
  const entry = backendEntry(backend)
  assert.ok(entry?.startsWith(path.join(root, 'node_modules')))
  const command = backendCommand(backend, 'http://127.0.0.1:12345', browserConfigSchema.parse({ mode: 'auto' }), path.join(root, 'private artifacts'))
  assert.equal(command[1], entry)
  const runtime = spawnSync(command[0], ['-p', "process.versions.bun ?? 'real-node'"], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(runtime.stdout.trim(), 'real-node')
  const probe = spawnSync(command[0], [entry, '--help'], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.equal(probe.status, 0, probe.stderr)
  assert.match(probe.stdout, backend === 'playwright' ? /--cdp-endpoint/ : /--browserUrl/)
  console.log(`${backend}: installed entry and CLI passed`)
}
console.log('Installed plugin import: passed. No source-tree imports or runtime downloads.')
