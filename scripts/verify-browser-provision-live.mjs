/**
 * Strongest end-to-end evidence for out-of-box browsing:
 * 1. force the managed path with an empty cache and no system candidates,
 * 2. let ensureBrowser download official Chrome for Testing,
 * 3. re-run discovery offline to prove cache reuse without network,
 * 4. print the executable so the live MCP test can consume it.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureBrowser } from "../dist/browser/provision.js"
import { discoverBrowser } from "../dist/browser/discovery.js"

const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-e2e-cache-"))
const started = Date.now()
try {
  const installed = await ensureBrowser(
    { mode: "auto", download: true },
    { cacheRoot, systemCandidates: [] },
  )
  assert.equal(installed.source, "managed", "expected the managed fallback to be selected")
  assert.ok(installed.buildId, "expected a resolved Chrome for Testing build id")
  console.log(`downloaded: ${installed.executable}`)
  console.log(`build: ${installed.buildId} in ${Math.round((Date.now() - started) / 1000)}s`)

  const reused = await discoverBrowser({}, { cacheRoot, systemCandidates: [] })
  assert.equal(reused?.source, "managed")
  assert.equal(reused?.executable, installed.executable)
  console.log("offline cache reuse: passed")
  console.log(`ORCHESTRA_TEST_CHROME=${installed.executable}`)
} finally {
  if (process.env.ORCHESTRA_KEEP_E2E_CACHE !== "1") await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined)
}
