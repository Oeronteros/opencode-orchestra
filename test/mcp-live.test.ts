import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { astGrepMcpCommand, gitMcpCommand } from "../src/mcp/commands.js"
import { smokeMcp } from "../src/mcp/smoke.js"
import { homeDirectory } from "../src/spawn.js"

const live = process.env.ORCHESTRA_LIVE_MCP === "1"
const localUvx = path.join(homeDirectory(), ".local", "bin", process.platform === "win32" ? "uvx.exe" : "uvx")
const uvx = process.env.ORCHESTRA_UVX ?? (existsSync(localUvx) ? localUvx : "uvx")

test("live Git MCP exposes repository tools", { skip: !live }, async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-git-"))
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0)
    const result = await smokeMcp({
      command: gitMcpCommand(uvx),
      cwd: repository,
      timeoutMs: 120_000,
      call: { tool: "git_status", arguments: { repo_path: repository } },
    })
    assert.equal(result.ok, true, result.error)
    assert.ok(result.tools.includes("git_status"))
  } finally {
    await rm(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test("live ast-grep MCP executes its native engine", { skip: !live }, async () => {
  const result = await smokeMcp({
    command: astGrepMcpCommand(uvx),
    timeoutMs: 120_000,
    call: { tool: "dump_syntax_tree", arguments: { code: "const value = 1", language: "typescript", format: "pattern" } },
  })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.tools.includes("find_code"))
})
