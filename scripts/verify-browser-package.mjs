import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'
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
const { discoverBrowser, browserCacheRoot } = await import(pathToFileURL(path.join(packageRoot, 'dist/browser/discovery.js')).href)
// Managed provisioning modules ship with the package and never execute at import time.
assert.ok(existsSync(path.join(packageRoot, 'dist/browser/provision.js')), 'provision module is packaged')
assert.ok(existsSync(path.join(packageRoot, 'dist/browser/download-worker.js')), 'download worker is packaged')
assert.equal(typeof (await import(pathToFileURL(path.join(packageRoot, 'dist/browser/provision.js')).href)).ensureBrowser, 'function')
// The default browser mode is enabled and the downloader dependency resolves inside the installation.
const defaultConfig = browserConfigSchema.parse({})
assert.equal(defaultConfig.mode, 'auto')
assert.equal(defaultConfig.download, true)
const installer = await import(pathToFileURL(path.join(packageRoot, 'node_modules/@puppeteer/browsers/package.json')).href, { with: { type: 'json' } })
assert.ok(installer.default.version, 'pinned @puppeteer/browsers resolves inside the installed package')
// Offline discovery must not fetch anything; a missing browser is a legitimate local answer.
const discovered = await discoverBrowser({}, { cacheRoot: path.join(root, 'no-browser-cache'), systemCandidates: [] })
assert.equal(discovered, undefined)
assert.ok(browserCacheRoot({ cacheRoot: path.join(root, 'cache with space') }).includes('cache with space'))
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
