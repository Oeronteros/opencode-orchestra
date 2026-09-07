import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { smokeConfiguredMcps } from "../src/mcp/config-smoke.js"

test("configured MCP smoke launches enabled local entries and skips disabled or remote entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-mcp-config-smoke-"))
  const fixture = path.resolve("test", "fixtures", "mcp-smoke-server.mjs")
  await writeFile(path.join(directory, "opencode.jsonc"), JSON.stringify({
    mcp: {
      git: { type: "local", command: [process.execPath, fixture], cwd: ".", enabled: true },
      "ast-grep": { type: "local", command: [process.execPath, fixture], enabled: true },
      context7: { type: "remote", url: "https://example.invalid", enabled: true },
      disabled: { type: "local", command: ["missing"], enabled: false },
    },
  }))

  const report = await smokeConfiguredMcps({ configDirectory: directory, projectDirectory: directory, timeoutMs: 5_000 })
  assert.equal(report.ok, true)
  assert.deepEqual(report.results.map(({ name, status }) => ({ name, status })), [
    { name: "git", status: "ok" },
    { name: "ast-grep", status: "ok" },
    { name: "context7", status: "skipped" },
    { name: "disabled", status: "skipped" },
  ])
  assert.ok(report.results[0]?.tools.includes("git_status"))
  assert.ok(report.results[1]?.tools.includes("dump_syntax_tree"))
})
