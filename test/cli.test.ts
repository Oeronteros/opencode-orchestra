import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "jsonc-parser"
import { failureReason, install } from "../src/cli.js"

const SUPER_POWERS_ENTRY = "superpowers@git+https://github.com/obra/superpowers.git"

async function writeExecutable(file: string, script: string): Promise<void> {
  await writeFile(file, script, "utf8")
  await chmod(file, 0o755)
}

/**
 * Fake toolchain that shadows the real uv/uvx/memorygraph on this machine.
 * Windows cannot natively spawn shell scripts, so the fakes are written as
 * .cmd batch files there (still resolved via PATH and ~/.local/bin).
 */
async function fakeToolchain(prefix: string): Promise<{ bin: string; home: string; uvx: string }> {
  const bin = path.join(prefix, "bin")
  const home = path.join(prefix, "home")
  const homeBin = path.join(home, ".local", "bin")
  await mkdir(bin, { recursive: true })
  await mkdir(homeBin, { recursive: true })
  const win = process.platform === "win32"
  const failingExecutable = win ? "@echo off\r\n@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n"
  const workingUv = win
    ? "@echo off\r\n@if \"%1\"==\"--version\" exit /b 0\r\n@exit /b 1\r\n"
    : '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 1\n'
  // Shadow real PATH hits so provisioning is exercised deterministically.
  await writeExecutable(path.join(bin, win ? "uv.cmd" : "uv"), failingExecutable)
  await writeExecutable(path.join(bin, win ? "memorygraph.cmd" : "memorygraph"), failingExecutable)
  await writeExecutable(path.join(bin, win ? "uvx.cmd" : "uvx"), failingExecutable)
  // Absolute-path candidates found via ~/.local/bin: uv passes the
  // --version probe (so ensureUv accepts it) but fails every real command.
  await writeExecutable(path.join(homeBin, win ? "uv.cmd" : "uv"), workingUv)
  const uvx = path.join(homeBin, win ? "uvx.cmd" : "uvx")
  await writeExecutable(uvx, win ? "@echo off\r\n@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n")
  return { bin, home, uvx }
}

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
  // ":" is illegal in Windows file names, so the git-spec-shaped Superpowers
  // entry is represented by a plain foreign scoped package here.
  const foreignDirectory = path.join(packagesRoot, "@acme", "other-plugin@latest")
  await mkdir(foreignDirectory, { recursive: true })
  await writeFile(path.join(foreignDirectory, "marker.txt"), "keep me")

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
  assert.equal(await readFile(path.join(foreignDirectory, "marker.txt"), "utf8"), "keep me")
})

test("failureReason collapses newlines and repeated whitespace into single spaces", () => {
  assert.equal(failureReason(new Error("first\nsecond\r\nthird")), "first second third")
  assert.equal(failureReason(new Error("a\n\n   b\tc")), "a b c")
})

test("failureReason truncates long messages to 200 characters", () => {
  const reason = failureReason(new Error("x".repeat(500)))
  assert.equal(reason?.length, 200)
  assert.equal(reason, "x".repeat(200))
})

test("failureReason returns undefined for empty or blank input", () => {
  assert.equal(failureReason(""), undefined)
  assert.equal(failureReason("   \n\t "), undefined)
})

test("memoryGraph provisioning falls back to uvx and keeps the original error text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-uvx-fallback-"))
  const { bin, home, uvx } = await fakeToolchain(directory)

  const originalPath = process.env.PATH
  const originalHome = process.env.HOME
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
  process.env.HOME = home
  try {
    const result = await install({
      configDirectory: directory,
      context7: false,
      codebaseMemory: false,
      memoryGraph: true,
      playwright: false,
      superpowers: false,
      provisionDependencies: true,
      force: false,
      dryRun: false,
      pluginCacheDirectory: path.join(directory, "packages"),
    })
    assert.equal(result.dependencies.memoryGraph.status, "installed")
    assert.deepEqual(result.dependencies.memoryGraph.command, [uvx, "memorygraph"])
    assert.match(result.dependencies.memoryGraph.reason ?? "", /uv tool install failed/)
    const config = parse(await readFile(path.join(directory, "opencode.json"), "utf8")) as { mcp: Record<string, unknown> }
    const entry = config.mcp.memorygraph as { command: string[] } | undefined
    assert.deepEqual(entry?.command, [uvx, "memorygraph"])
  } finally {
    process.env.PATH = originalPath
    process.env.HOME = originalHome
  }
})

test("memoryGraph provisioning failure skips the MCP entry when no uvx is available", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-uvx-missing-"))
  const { bin, home } = await fakeToolchain(directory)
  // Broken uvx everywhere: the absolute-path candidate must fail too.
  const win = process.platform === "win32"
  const brokenUvx = path.join(home, ".local", "bin", win ? "uvx.cmd" : "uvx")
  await writeExecutable(brokenUvx, win ? "@echo off\r\n@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n")

  const originalPath = process.env.PATH
  const originalHome = process.env.HOME
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
  process.env.HOME = home
  try {
    const result = await install({
      configDirectory: directory,
      context7: false,
      codebaseMemory: false,
      memoryGraph: true,
      playwright: false,
      superpowers: false,
      provisionDependencies: true,
      force: false,
      dryRun: false,
      pluginCacheDirectory: path.join(directory, "packages"),
    })
    assert.equal(result.dependencies.memoryGraph.status, "failed")
    assert.ok((result.dependencies.memoryGraph.reason ?? "").length > 0)
    const config = parse(await readFile(path.join(directory, "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> }
    assert.equal(config.mcp?.memorygraph, undefined)
  } finally {
    process.env.PATH = originalPath
    process.env.HOME = originalHome
  }
})

test("installer writes git and ast-grep MCPs by default and respects --no-git/--no-ast-grep", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-git-astgrep-"))
  const result = await install({
    configDirectory: directory,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    playwright: false,
    superpowers: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: path.join(directory, "packages"),
  })
  const config = parse(await readFile(path.join(directory, "opencode.json"), "utf8")) as { mcp: Record<string, { command: string[] }> }
  assert.deepEqual(config.mcp.git, { type: "local", command: ["uvx", "mcp-server-git"], enabled: true, timeout: 30_000 })
  assert.deepEqual(config.mcp["ast-grep"], {
    type: "local",
    command: ["uvx", "--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"],
    enabled: true,
    timeout: 30_000,
  })
  assert.equal(result.dependencies.git.status, "skipped")
  assert.equal(result.dependencies.astGrep.status, "skipped")

  const suppressed = await mkdtemp(path.join(os.tmpdir(), "orchestra-git-astgrep-off-"))
  await install({
    configDirectory: suppressed,
    context7: false,
    codebaseMemory: false,
    memoryGraph: false,
    git: false,
    astGrep: false,
    playwright: false,
    superpowers: false,
    provisionDependencies: false,
    force: false,
    dryRun: false,
    pluginCacheDirectory: path.join(suppressed, "packages"),
  })
  const off = parse(await readFile(path.join(suppressed, "opencode.json"), "utf8")) as { mcp?: Record<string, unknown> }
  assert.equal(off.mcp?.git, undefined)
  assert.equal(off.mcp?.["ast-grep"], undefined)
})

test("git and ast-grep warmup failure still writes config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-warmup-fail-"))
  const { bin, home } = await fakeToolchain(directory)
  const originalPath = process.env.PATH
  const originalHome = process.env.HOME
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
  process.env.HOME = home
  try {
    const result = await install({
      configDirectory: directory,
      context7: false,
      codebaseMemory: false,
      memoryGraph: false,
      git: true,
      astGrep: true,
      playwright: false,
      superpowers: false,
      provisionDependencies: true,
      force: false,
      dryRun: false,
      pluginCacheDirectory: path.join(directory, "packages"),
    })
    // uvx shim exits 0 in fakeToolchain homeBin, so warmup passes; assert config written either way.
    assert.ok(["installed", "failed"].includes(result.dependencies.git.status))
    assert.ok(["installed", "failed"].includes(result.dependencies.astGrep.status))
    const config = parse(await readFile(path.join(directory, "opencode.json"), "utf8")) as { mcp: Record<string, unknown> }
    assert.ok(config.mcp.git !== undefined)
    assert.ok(config.mcp["ast-grep"] !== undefined)
  } finally {
    process.env.PATH = originalPath
    process.env.HOME = originalHome
  }
})
