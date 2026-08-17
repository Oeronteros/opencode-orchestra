import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { completionFor, bashCompletion } from "../src/diagnostics/completion.js"
import { compareVersions, formatUpdateResult } from "../src/diagnostics/update.js"
import { formatDoctorReport, readConfigFile, runDoctor, type Check } from "../src/diagnostics/doctor.js"

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
