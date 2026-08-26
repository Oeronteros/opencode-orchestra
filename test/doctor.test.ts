import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { completionFor, bashCompletion } from "../src/diagnostics/completion.js"
import { compareVersions, formatUpdateResult } from "../src/diagnostics/update.js"
import { findMainConfig, formatDoctorReport, readConfigFile, runDoctor, type Check } from "../src/diagnostics/doctor.js"

test("compareVersions orders dotted versions", () => {
  assert.ok(compareVersions("0.5.3", "0.5.4") < 0)
  assert.ok(compareVersions("0.5.4", "0.5.3") > 0)
  assert.equal(compareVersions("0.5.3", "0.5.3"), 0)
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0)
  assert.ok(compareVersions("0.5.3", "0.5.10") < 0)
})

test("formatUpdateResult reports newer, current, and unknown", () => {
  const newer = formatUpdateResult({ current: "0.5.3", latest: "0.6.0" })
  assert.match(newer, /newer version is available: 0\.6\.0/)
  assert.match(newer, /bunx @oeronteros-1\/opencode-orchestra@latest install --force/)

  const same = formatUpdateResult({ current: "0.6.0", latest: "0.6.0" })
  assert.match(same, /latest version/)

  const offline = formatUpdateResult({ current: "0.5.3" })
  assert.match(offline, /Could not reach the npm registry/)

  const prerelease = formatUpdateResult({ current: "0.5.3-beta", latest: "0.5.3" })
  assert.match(prerelease, /Latest published version: 0\.5\.3/)
})

test("completionFor emits each shell family", () => {
  const bash = completionFor("bash")
  assert.match(bash, /complete -F _opencode_orchestra_completion opencode-orchestra/)
  assert.match(bash, /install\|dashboard\|doctor\|update\|completion/)
  for (const word of ["install", "dashboard", "doctor", "update", "completion", "--help"]) {
    assert.ok(bash.includes(word), `bash completion mentions ${word}`)
  }

  const zsh = completionFor("zsh")
  assert.match(zsh, /#compdef opencode-orchestra/)
  assert.match(zsh, /_describe/)

  const pwsh = completionFor("pwsh")
  assert.match(pwsh, /Register-ArgumentCompleter -Native -CommandName opencode-orchestra/)
  assert.match(pwsh, /CompletionResult/)

  assert.equal(completionFor("powershell"), pwsh)
  assert.throws(() => completionFor("fish"), /Unsupported shell/)
})

test("bashCompletion supports a custom program name", () => {
  const c = bashCompletion("oo")
  assert.match(c, /complete -F _oo_completion oo/)
})

test("readConfigFile accepts a UTF-8 BOM", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-bom-"))
  const file = path.join(directory, "opencode.jsonc")
  await writeFile(file, "\ufeff{\"plugin\":[\"@oeronteros-1/opencode-orchestra@latest\"]}", "utf8")
  const result = await readConfigFile(file)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.parsed.plugin, ["@oeronteros-1/opencode-orchestra@latest"])
})

test("readConfigFile reports JSONC syntax errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-"))
  const file = path.join(directory, "opencode.jsonc")
  await writeFile(file, "{ \"plugin\": [", "utf8")
  const result = await readConfigFile(file)
  assert.equal(result.exists, true)
  assert.equal(result.errors.length > 0, true)

  const clean = path.join(directory, "ok.jsonc")
  await writeFile(clean, "{ \"plugin\": [\"x\"] }", "utf8")
  const ok = await readConfigFile(clean)
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.parsed.plugin, ["x"])

  const missing = await readConfigFile(path.join(directory, "nope.json"))
  assert.equal(missing.exists, false)
})

test("findMainConfig prefers opencode.jsonc when both files exist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-dual-"))
  await writeFile(path.join(directory, "opencode.json"), "{}\n", "utf8")
  await writeFile(path.join(directory, "opencode.jsonc"), "{}\n", "utf8")

  assert.equal(await findMainConfig(directory), path.join(directory, "opencode.jsonc"))
})

test("runDoctor checks config presence and validity without touching the network", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-cfg-"))
  await writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({ plugin: ["@oeronteros-1/opencode-orchestra@latest"] }),
    "utf8",
  )
  await writeFile(
    path.join(directory, "orchestra.jsonc"),
    JSON.stringify({ budget: "balanced" }),
    "utf8",
  )

  const report = await runDoctor({ configDirectory: directory })
  assert.equal(report.configDirectory, directory)
  assert.equal(report.mainConfig.exists, true)
  assert.equal(report.orchestraConfig.exists, true)

  const byId = new Map(report.checks.map((c: Check) => [c.id, c]))
  assert.equal(byId.get("main-config")?.status, "ok")
  assert.equal(byId.get("orchestra-config")?.status, "ok")
  assert.equal(byId.get("plugin-entry")?.status, "ok")

  assert.equal(report.checks.some((c: Check) => c.status === "error"), false)

  const formatted = formatDoctorReport(report)
  assert.match(formatted, /OpenCode Orchestra doctor/)
  assert.match(formatted, /plugin entry/)
})

test("runDoctor flags an absent plugin entry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-noplugin-"))
  await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ plugin: ["other"] }), "utf8")
  const report = await runDoctor({ configDirectory: directory })
  const entry = report.checks.find((c: Check) => c.id === "plugin-entry")
  assert.equal(entry?.status, "warning")
})

test("runDoctor probes the full argv for multi-command local MCPs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-argv-"))
  const bin = path.join(directory, "bin")
  await mkdir(bin, { recursive: true })
  const win = process.platform === "win32"
  const fakeUvx = path.join(bin, win ? "uvx.cmd" : "uvx")
  await writeFile(
    fakeUvx,
    win
      ? [
          "@echo off",
          'if "%1"=="--version" if "%2"=="" exit /b 0',
          'if "%1"=="memorygraph" if "%2"=="--version" exit /b 0',
          "exit /b 1",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then exit 0; fi',
          'if [ "$#" -eq 2 ] && [ "$1" = "memorygraph" ] && [ "$2" = "--version" ]; then exit 0; fi',
          "exit 1",
          "",
        ].join("\n"),
    "utf8",
  )
  await chmod(fakeUvx, 0o755)

  const configFile = path.join(directory, "opencode.json")
  await writeFile(
    configFile,
    JSON.stringify({ plugin: ["@oeronteros-1/opencode-orchestra@latest"], mcp: { memorygraph: { type: "local", command: [fakeUvx, "memorygraph"] } } }),
    "utf8",
  )
  const working = await runDoctor({ configDirectory: directory })
  const ok = working.checks.find((c: Check) => c.id === "mcp-memorygraph")
  assert.equal(ok?.status, "ok")
  assert.equal(ok?.detail, `${fakeUvx} memorygraph`)

  await writeFile(
    configFile,
    JSON.stringify({ plugin: ["@oeronteros-1/opencode-orchestra@latest"], mcp: { memorygraph: { type: "local", command: [fakeUvx, "bogus"] } } }),
    "utf8",
  )
  const broken = await runDoctor({ configDirectory: directory })
  const warning = broken.checks.find((c: Check) => c.id === "mcp-memorygraph")
  assert.equal(warning?.status, "warning")
})

test("runDoctor probes duplicate tool candidates once and honors HOME for ~/.local/bin", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-doctor-dedupe-"))
  const win = process.platform === "win32"
  const ext = win ? ".cmd" : ""
  const home = path.join(directory, "home")
  const homeBin = path.join(home, ".local", "bin")
  await mkdir(homeBin, { recursive: true })
  const counter = path.join(directory, "probes.txt")

  // Fake uv: passes --version and reports ~/.local/bin as its tool bin dir,
  // so the memorygraph candidate list contains the same path twice.
  await writeFile(
    path.join(homeBin, `uv${ext}`),
    win
      ? [
          "@echo off",
          'if "%1"=="--version" echo uv 1.2.3',
          'if "%1"=="--version" exit /b 0',
          'if "%1"=="tool" if "%2"=="dir" if "%3"=="--bin" echo ' + homeBin,
          "exit /b 1",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "uv 1.2.3"; exit 0; fi',
          'if [ "$1" = "tool" ] && [ "$2" = "dir" ] && [ "$3" = "--bin" ]; then echo "' + homeBin + '"; fi',
          "exit 1",
          "",
        ].join("\n"),
    "utf8",
  )
  await chmod(path.join(homeBin, `uv${ext}`), 0o755)

  // Fake memorygraph: every probe appends to the counter file and fails.
  await writeFile(
    path.join(homeBin, `memorygraph${ext}`),
    win
      ? ["@echo off", `echo probed>>"${counter}"`, "@exit /b 1", ""].join("\r\n")
      : ['#!/bin/sh', `echo probed >> "${counter}"`, "exit 1", ""].join("\n"),
    "utf8",
  )
  await chmod(path.join(homeBin, `memorygraph${ext}`), 0o755)

  const configDirectory = path.join(directory, "config")
  await mkdir(configDirectory, { recursive: true })
  await writeFile(
    path.join(configDirectory, "opencode.json"),
    JSON.stringify({ plugin: ["@oeronteros-1/opencode-orchestra@latest"] }),
    "utf8",
  )

  const originalPath = process.env.PATH
  const originalHome = process.env.HOME
  const originalLocalAppData = process.env.LOCALAPPDATA
  // Bare-name candidates must resolve to nothing (PATH empty), so only the
  // absolute ~/.local/bin candidates can execute the counter fake.
  delete process.env.PATH
  process.env.HOME = home
  delete process.env.LOCALAPPDATA
  try {
    const report = await runDoctor({ configDirectory })
    const byId = new Map(report.checks.map((c: Check) => [c.id, c]))
    assert.equal(byId.get("uv")?.status, "ok")
    assert.match(byId.get("uv")?.detail ?? "", /uv 1\.2\.3/)
    assert.equal(byId.get("memorygraph")?.status, "warning")

    const probes = (await readFile(counter, "utf8")).split("\n").filter((line) => line.trim()).length
    // uv's tool bin dir equals ~/.local/bin, so the duplicated candidate is
    // probed exactly once instead of twice.
    assert.equal(probes, 1)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocalAppData
  }
})
