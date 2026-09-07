import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { smokeMcp } from "../src/mcp/smoke.js"

const fixture = path.resolve("test", "fixtures", "mcp-smoke-server.mjs")

test("smokeMcp performs initialize, tools/list, and a harmless tool call", async () => {
  const result = await smokeMcp({
    command: [process.execPath, fixture],
    timeoutMs: 5_000,
    call: { tool: "ping", arguments: {} },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools, ["ping", "git_status", "dump_syntax_tree"])
  assert.equal(result.callOutput, "pong")
  assert.ok(result.durationMs >= 0)
})

test("smokeMcp reports a missing tool without hanging", async () => {
  const result = await smokeMcp({
    command: [process.execPath, fixture],
    timeoutMs: 5_000,
    call: { tool: "missing", arguments: {} },
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /tool not found/)
})
