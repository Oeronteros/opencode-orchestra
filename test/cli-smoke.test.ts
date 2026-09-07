import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const cli = path.resolve("dist/cli.js")

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" })
}

test("built CLI prints help", () => {
  const result = runCli("--help")
  assert.equal(result.status, 0)
  assert.match(result.stdout, /OpenCode Orchestra/)
  assert.match(result.stdout, /completion\s+Print shell completion/)
})

test("built CLI rejects an unknown command", () => {
  const result = runCli("not-a-command")
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown command: not-a-command/)
})

test("built CLI emits zsh completion", () => {
  const result = runCli("completion", "zsh")
  assert.equal(result.status, 0)
  assert.match(result.stdout, /#compdef opencode-orchestra/)
  assert.match(result.stdout, /_opencode_orchestra\(\)/)
})

test("built CLI runs offline doctor JSON against a temporary config directory", async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "orchestra-cli-doctor-"))
  const result = spawnSync(process.execPath, [cli, "doctor", "--json", "--config-dir", configDirectory], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", HOME: configDirectory },
  })
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout) as {
    environment?: { platform?: string; nodeVersion?: string }
    configDirectory?: string
    mainConfig?: { path?: string; exists?: boolean; errors?: unknown[] }
    orchestraConfig?: { path?: string; exists?: boolean; errors?: unknown[] }
    checks?: Array<{ id?: string; label?: string; status?: string; detail?: string }>
  }
  assert.equal(report.configDirectory, path.resolve(configDirectory))
  assert.match(report.environment?.platform ?? "", /\w+/)
  assert.match(report.environment?.nodeVersion ?? "", /^v\d+/)
  assert.equal(report.mainConfig?.exists, false)
  assert.deepEqual(report.mainConfig?.errors, [])
  assert.equal(report.orchestraConfig?.exists, false)
  assert.deepEqual(report.orchestraConfig?.errors, [])
  assert.ok(Array.isArray(report.checks))
  assert.ok(report.checks.length > 0)
  for (const check of report.checks) {
    assert.match(check.id ?? "", /^\w[\w.-]+$/)
    assert.match(check.label ?? "", /\w+/)
    assert.ok(["error", "warning", "ok", "info"].includes(check.status ?? ""))
    assert.match(check.detail ?? "", /\w+/)
  }
})

test("built CLI runs configured MCP smoke and returns JSON", async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "orchestra-cli-mcp-smoke-"))
  const fixture = path.resolve("test", "fixtures", "mcp-smoke-server.mjs")
  await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({
    mcp: { fixture: { type: "local", command: [process.execPath, fixture], enabled: true } },
  }))
  const result = runCli("mcp-smoke", "--json", "--config-dir", configDirectory, "--directory", configDirectory)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as { ok?: boolean; results?: Array<{ name?: string; status?: string; tools?: string[] }> }
  assert.equal(report.ok, true)
  assert.equal(report.results?.[0]?.name, "fixture")
  assert.equal(report.results?.[0]?.status, "ok")
  assert.ok(report.results?.[0]?.tools?.includes("ping"))
})
