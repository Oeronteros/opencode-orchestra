import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureBrowser, BROWSER_DOWNLOAD_TIMEOUT_MS } from "../src/browser/provision.js"

test("provisioning reuses an explicit browser without launching downloader", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-provision-"))
  const executable = path.join(root, "chrome.exe")
  await writeFile(executable, "fixture")
  assert.equal((await ensureBrowser({ executable, mode: "auto", download: true }, { workerEntry: "missing" })).source, "configured")
  assert.equal(BROWSER_DOWNLOAD_TIMEOUT_MS, 600_000)
})
test("disabled downloads and unsupported platform fail without network", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-empty-"))
  await assert.rejects(() => ensureBrowser({ mode: "auto", download: false }, { cacheRoot, systemCandidates: [] }), /browser_chrome_missing/)
  await assert.rejects(() => ensureBrowser({ mode: "auto", download: true }, { cacheRoot, systemCandidates: [], platform: "linux", arch: "arm64" }), /browser_platform_unsupported/)
})
