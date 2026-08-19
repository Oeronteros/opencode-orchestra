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
  assert.deepEqual(config.plugin, ["existing", "@oeronteros-1/opencode-orchestra@latest"])
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
  assert.deepEqual(config.plugin, ["opencode-supermemory", "existing", "@oeronteros-1/opencode-orchestra@latest"])
  assert.equal(result.changed.some((item) => item.startsWith("removed:")), false)
})

test("installer upgrades a bare/pinned plugin entry to @latest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-upgrade-"))
  const configFile = path.join(directory, "opencode.jsonc")

  for (const [label, before, after] of [
    ["bare name", "@oeronteros-1/opencode-orchestra", "@oeronteros-1/opencode-orchestra@latest"],
    ["pinned version", "@oeronteros-1/opencode-orchestra@0.5.1", "@oeronteros-1/opencode-orchestra@latest"],
  ] as const) {
    await writeFile(configFile, `{"plugin":["${before}"]}\n`)
    const result = await install({
      configDirectory: directory,
      context7: false,
      codebaseMemory: false,
      memoryGraph: false,
      provisionDependencies: false,
      force: false,
      dryRun: false,
    })
    const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }
    assert.deepEqual(config.plugin, [after], label)
    assert.ok(result.changed.includes("plugin"), label)
  }
})

test("installer accepts a UTF-8 BOM in JSONC config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-bom-"))
  const configFile = path.join(directory, "opencode.jsonc")
  await writeFile(configFile, "\ufeff{\"plugin\":[\"existing\"]}\n")
  const result = await install({ configDirectory: directory, context7: false, codebaseMemory: false, memoryGraph: false, provisionDependencies: false, force: false, dryRun: false })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }
  assert.deepEqual(config.plugin, ["existing", "@oeronteros-1/opencode-orchestra@latest"])
  assert.ok(result.changed.includes("plugin"))
})

test("installer keeps an existing @latest entry unchanged and idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-latest-"))
  const configFile = path.join(directory, "opencode.jsonc")
  await writeFile(configFile, '{"plugin":["@oeronteros-1/opencode-orchestra@latest"]}\n')

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
  })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }

  assert.deepEqual(config.plugin, ["@oeronteros-1/opencode-orchestra@latest"])
  assert.equal(result.changed.includes("plugin"), false)
})
