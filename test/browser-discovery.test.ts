import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { browserCacheRoot, discoverBrowser } from "../src/browser/discovery.js"

test("explicit browser executable has priority and invalid explicit paths fail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-discovery-"))
  const executable = path.join(root, "Chrome With Spaces")
  await writeFile(executable, "browser")
  const found = await discoverBrowser({ executable }, { systemCandidates: [path.join(root, "system")] })
  assert.deepEqual(found, { source: "configured", executable })
  await assert.rejects(() => discoverBrowser({ executable: path.join(root, "missing") }), /browser_executable_invalid/)
})

test("managed metadata is accepted only when it points to a completed executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  const build = path.join(root, "builds", "stable")
  await mkdir(build, { recursive: true })
  const executable = path.join(build, "chrome")
  await writeFile(executable, "browser")
  await writeFile(path.join(root, "current.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, buildId: "stable", executableRelativePath: "builds/stable/chrome", complete: true }))
  const found = await discoverBrowser({}, { cacheRoot: root, systemCandidates: [] })
  assert.deepEqual(found, { source: "managed", executable, buildId: "stable" })
})

test("cache root follows the platform data directory", () => {
  assert.equal(browserCacheRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Local" } }), path.join("C:\\Local", "opencode-orchestra", "chrome-for-testing"))
  assert.equal(browserCacheRoot({ platform: "linux", env: { XDG_DATA_HOME: "/data" } }), path.join("/data", "opencode-orchestra", "chrome-for-testing"))
})
