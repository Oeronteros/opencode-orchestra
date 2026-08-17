import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "jsonc-parser"
import { install } from "../src/cli.js"

test("installer merges plugin and MCPs while preserving existing entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-install-"))
  const configFile = path.join(directory, "opencode.jsonc")
  await writeFile(
    configFile,
    '{\n  // keep this comment\n  "plugin": ["existing"],\n  "mcp": { "context7": { "type": "remote", "url": "https://custom.invalid" } }\n}\n',
  )

  const result = await install({
    configDirectory: directory,
    context7: true,
    codebaseMemory: true,
    memoryGraph: true,
    provisionDependencies: false,
    force: false,
    dryRun: false,
  })
  const text = await readFile(configFile, "utf8")
  const config = parse(text) as Record<string, unknown>
  const mcp = config.mcp as Record<string, { url: string }>

  assert.ok(text.includes("// keep this comment"))
  assert.deepEqual(config.plugin, ["existing", "@oeronteros-1/opencode-orchestra"])
  assert.equal(mcp.context7?.url, "https://custom.invalid")
  assert.deepEqual(mcp["codebase-memory"], {
    type: "local",
    command: ["codebase-memory-mcp"],
    enabled: true,
    timeout: 30_000,
  })
  assert.deepEqual(mcp.memorygraph, {
    type: "local",
    command: ["memorygraph"],
    enabled: true,
    timeout: 30_000,
  })
  assert.ok(result.backup)
  assert.ok(result.preserved.includes("mcp.context7"))
  assert.equal(parse(await readFile(result.orchestraConfig, "utf8")).models.strategy, "auto")
})

test("installer is idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-idempotent-"))
  const options = {
    configDirectory: directory,
    context7: true,
    codebaseMemory: true,
    memoryGraph: true,
    provisionDependencies: false,
    force: false,
    dryRun: false,
  } as const
  await install(options)
  const second = await install(options)

  assert.deepEqual(second.changed, [])
  assert.equal(second.backup, undefined)
})

test("installer preserves user-configured Supermemory entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-migrate-"))
  const configFile = path.join(directory, "opencode.json")
  await writeFile(
    configFile,
    '{"plugin":["opencode-supermemory","existing"],"mcp":{"supermemory":{"type":"remote","url":"https://mcp.supermemory.ai/mcp"}}}\n',
  )

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
  })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[]; mcp: Record<string, unknown> }

  assert.deepEqual(config.mcp.supermemory, { type: "remote", url: "https://mcp.supermemory.ai/mcp" })
  assert.deepEqual(config.plugin, ["opencode-supermemory", "existing", "@oeronteros-1/opencode-orchestra"])
  assert.equal(result.changed.some((item) => item.startsWith("removed:")), false)
})
