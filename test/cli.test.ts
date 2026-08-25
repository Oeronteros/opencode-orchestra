import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "jsonc-parser"
import { install } from "../src/cli.js"

const SUPER_POWERS_ENTRY = "superpowers@git+https://github.com/obra/superpowers.git"

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
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const text = await readFile(configFile, "utf8")
  const config = parse(text) as Record<string, unknown>
  const mcp = config.mcp as Record<string, { url: string }>

  assert.ok(text.includes("// keep this comment"))
  assert.deepEqual(config.plugin, ["existing", "@oeronteros-1/opencode-orchestra@latest", SUPER_POWERS_ENTRY])
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
    pluginCacheDirectory: path.join(directory, "packages"),
  } as const
  await install(options)
  const config = parse(await readFile(path.join(directory, "opencode.json"), "utf8")) as { plugin: string[] }
  assert.ok(config.plugin.includes(SUPER_POWERS_ENTRY))
  const second = await install(options)

  assert.deepEqual(second.changed, [])
  assert.equal(second.backup, undefined)
})

test("installer updates opencode.jsonc when both main config files exist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-dual-config-"))
  const jsonFile = path.join(directory, "opencode.json")
  const jsoncFile = path.join(directory, "opencode.jsonc")
  const jsonOriginal = '{"plugin":["json-only"]}\n'
  await writeFile(jsonFile, jsonOriginal)
  await writeFile(
    jsoncFile,
    '{\n  // loaded after opencode.json\n  "plugin": ["@oeronteros-1/opencode-orchestra@1.0.15"]\n}\n',
  )

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    playwright: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const jsoncText = await readFile(jsoncFile, "utf8")
  const jsonc = parse(jsoncText) as { plugin: string[] }

  assert.equal(result.openCodeConfig, jsoncFile)
  assert.equal(await readFile(jsonFile, "utf8"), jsonOriginal)
  assert.ok(jsoncText.includes("// loaded after opencode.json"))
  assert.deepEqual(jsonc.plugin, ["@oeronteros-1/opencode-orchestra@1.0.15", SUPER_POWERS_ENTRY])
})

test("installer preserves a pinned Orchestra version when Superpowers is already configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-pinned-"))
  const configFile = path.join(directory, "opencode.jsonc")
  await writeFile(
    configFile,
    `{"plugin":["@oeronteros-1/opencode-orchestra@1.0.15","${SUPER_POWERS_ENTRY}"]}\n`,
  )

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    playwright: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }

  assert.deepEqual(config.plugin, ["@oeronteros-1/opencode-orchestra@1.0.15", SUPER_POWERS_ENTRY])
  assert.deepEqual((config as Record<string, unknown>).agent, { "orch-lead": { mode: "primary", hidden: false } })
  const cacheRoot = process.env.XDG_CACHE_HOME
    ?? (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined)
    ?? path.join(os.homedir(), ".cache")
  assert.deepEqual((config as { skills?: { paths?: string[] } }).skills?.paths, [
    path.join(cacheRoot, "opencode", "packages", SUPER_POWERS_ENTRY, "node_modules", "superpowers", "skills"),
  ])
  assert.equal(result.changed.includes("plugin"), false)
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
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[]; mcp: Record<string, unknown> }

  assert.deepEqual(config.mcp.supermemory, { type: "remote", url: "https://mcp.supermemory.ai/mcp" })
  assert.deepEqual(config.plugin, ["opencode-supermemory", "existing", "@oeronteros-1/opencode-orchestra@latest", SUPER_POWERS_ENTRY])
  assert.equal(result.changed.some((item) => item.startsWith("removed:")), false)
})

test("installer upgrades a bare entry and preserves a pinned version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-upgrade-"))
  const configFile = path.join(directory, "opencode.jsonc")

  for (const [label, before, after] of [
    ["bare name", "@oeronteros-1/opencode-orchestra", "@oeronteros-1/opencode-orchestra@latest"],
    ["pinned version", "@oeronteros-1/opencode-orchestra@0.5.1", "@oeronteros-1/opencode-orchestra@0.5.1"],
  ] as const) {
    await writeFile(configFile, `{"plugin":["${before}"]}\n`)
    const result = await install({
      configDirectory: directory,
      context7: false,
      codebaseMemory: false,
      memoryGraph: false,
      superpowers: false,
      provisionDependencies: false,
      force: false,
      dryRun: false,
      pluginCacheDirectory: path.join(directory, "packages"),
    })
    const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }
    assert.deepEqual(config.plugin, [after], label)
    assert.equal(result.changed.includes("plugin"), label === "bare name", label)
  }
})

test("installer accepts a UTF-8 BOM in JSONC config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-bom-"))
  const configFile = path.join(directory, "opencode.jsonc")
  await writeFile(configFile, "\ufeff{\"plugin\":[\"existing\"]}\n")
  const result = await install({ configDirectory: directory, context7: false, codebaseMemory: false, memoryGraph: false, provisionDependencies: false, force: false, dryRun: false, pluginCacheDirectory: path.join(directory, "packages") })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }
  assert.deepEqual(config.plugin, ["existing", "@oeronteros-1/opencode-orchestra@latest", SUPER_POWERS_ENTRY])
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
    superpowers: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }

  assert.deepEqual(config.plugin, ["@oeronteros-1/opencode-orchestra@latest"])
  assert.equal(result.changed.includes("plugin"), false)
})

test("installer skips the Superpowers entry with superpowers: false", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-nosuper-"))
  const configFile = path.join(directory, "opencode.jsonc")
  await writeFile(configFile, '{"plugin":["@oeronteros-1/opencode-orchestra@latest"]}\n')

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    superpowers: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }

  assert.deepEqual(config.plugin, ["@oeronteros-1/opencode-orchestra@latest"])
  assert.equal(result.changed.includes("plugin"), false)
})

test("installer preserves an existing Superpowers entry in any form", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-super-"))
  const configFile = path.join(directory, "opencode.jsonc")

  for (const seeded of [
    SUPER_POWERS_ENTRY,
    "superpowers@git+https://github.com/obra/superpowers.git#v6.3.0",
    "~/.config/opencode/node_modules/superpowers",
  ]) {
    await writeFile(configFile, `{"plugin":["@oeronteros-1/opencode-orchestra@latest","${seeded}"]}\n`)
    const result = await install({
      configDirectory: directory,
      context7: false,
      codebaseMemory: false,
      memoryGraph: false,
      provisionDependencies: false,
      force: false,
      dryRun: false,
      pluginCacheDirectory: path.join(directory, "packages"),
    })
    const config = parse(await readFile(configFile, "utf8")) as { plugin: string[] }

    assert.equal(config.plugin.length, 2, seeded)
    assert.ok(config.plugin.includes(seeded), seeded)
    assert.equal(result.changed.includes("plugin"), false, seeded)
  }
})

test("installer dry-run reports intended changes without writing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-dryrun-"))

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    playwright: false,
    provisionDependencies: false,
    force: false,
    dryRun: true,
    pluginCacheDirectory: path.join(directory, "packages"),
  })

  assert.ok(result.changed.includes("plugin"))
  assert.ok(result.changed.includes("orchestra.jsonc"))
  assert.equal(result.backup, undefined)
  await assert.rejects(readFile(path.join(directory, "opencode.json"), "utf8"), { code: "ENOENT" })
})

test("installer reports the OpenCode plugin cache refresh without touching unrelated entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-wiring-"))
  const packagesRoot = path.join(directory, "packages")
  const superpowersDirectory = path.join(packagesRoot, "superpowers@git+https:/github.com")
  await mkdir(superpowersDirectory, { recursive: true })
  await writeFile(path.join(superpowersDirectory, "marker.txt"), "keep me")

  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    superpowers: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: packagesRoot,
  })

  assert.deepEqual(result.pluginCache, { upToDate: [], reinstalled: [], invalidated: [] })
  assert.equal(await readFile(path.join(superpowersDirectory, "marker.txt"), "utf8"), "keep me")
})
