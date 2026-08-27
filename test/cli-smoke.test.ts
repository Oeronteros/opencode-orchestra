import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
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
  const report = JSON.parse(result.stdout) as { checks?: unknown[] }
  assert.ok(Array.isArray(report.checks))
})
