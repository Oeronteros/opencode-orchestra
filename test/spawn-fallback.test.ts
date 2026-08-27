import assert from "node:assert/strict"
import { spawnSync as nodeSpawnSync } from "node:child_process"
import os from "node:os"
import test from "node:test"
import { homeDirectory, quoteLineForCmd, safeForCmdRetry, spawnWithCmdFallback } from "../src/spawn.js"

test("quoteLineForCmd quotes spaces and cmd metacharacters", () => {
  assert.equal(quoteLineForCmd(["uv"]), "uv")
  assert.equal(quoteLineForCmd(["C:\\Program Files\\uv\\uv.exe"]), '"C:\\Program Files\\uv\\uv.exe"')
  assert.equal(quoteLineForCmd(["a&b"]), '"a&b"')
  assert.equal(quoteLineForCmd(["a<b"]), '"a<b"')
  assert.equal(quoteLineForCmd(["a>b"]), '"a>b"')
  assert.equal(quoteLineForCmd(["a|b"]), '"a|b"')
  assert.equal(quoteLineForCmd(["a^b"]), '"a^b"')
  // `%` alone does not force quoting: the retry guard rejects such parts
  // before the line is ever built.
  assert.equal(quoteLineForCmd(["100%"]), "100%")
  assert.equal(quoteLineForCmd(["uv", "--version"]), "uv --version")
  assert.equal(quoteLineForCmd(["run", "a b", "c&d"]), 'run "a b" "c&d"')
  assert.equal(quoteLineForCmd([]), "")
})

test("safeForCmdRetry rejects parts cmd.exe reinterprets inside quotes", () => {
  assert.equal(safeForCmdRetry(["uv", "--version"]), true)
  assert.equal(safeForCmdRetry(["C:\\Program Files\\x\\y.cmd", "--version"]), true)
  assert.equal(safeForCmdRetry(["C:\\dir with spaces\\tool.exe"]), true)
  // Embedded quote flips cmd's quoting state and can free a trailing `& cmd`.
  assert.equal(safeForCmdRetry(['nonexistent" & calc']), false)
  // `%VAR%` expands inside double quotes.
  assert.equal(safeForCmdRetry(["C:\\Users\\%USERNAME%\\bin"]), false)
  // CR/LF split commands regardless of quoting.
  assert.equal(safeForCmdRetry(["line1\nline2"]), false)
  assert.equal(safeForCmdRetry(["line1\rline2"]), false)
  // `,` and `;` are argument delimiters for cmd.exe.
  assert.equal(safeForCmdRetry(["a,b"]), false)
  assert.equal(safeForCmdRetry(["a;b"]), false)
  // `!VAR!` expands on hosts with delayed expansion enabled.
  assert.equal(safeForCmdRetry(["a!b"]), false)
})

test("spawnWithCmdFallback runs natively off-Windows and never shells out", () => {
  const ok = spawnWithCmdFallback(process.execPath, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  assert.equal(ok.status, 0)

  const missing = spawnWithCmdFallback("definitely-not-a-real-tool-xyz", ["--version"], { stdio: "ignore" })
  if (process.platform === "win32") {
    // The shell retry reports not-found as a nonzero exit, not an error.
    assert.notEqual(missing.status, 0)
  } else {
    assert.ok(missing.error)
    assert.equal(missing.status, null)
  }
})

test("spawnWithCmdFallback retries a failed Windows spawn through cmd", () => {
  const calls: Array<{ command: string; args: string[]; options: object }> = []
  const directFailure = { error: Object.assign(new Error("invalid executable"), { code: "EINVAL" }) } as unknown as ReturnType<typeof nodeSpawnSync>
  const retrySuccess = { status: 0, signal: null, output: [], stdout: "ok", stderr: "" } as unknown as ReturnType<typeof nodeSpawnSync>
  const fakeSpawnSync = (command: string, args: string[], options: object) => {
    calls.push({ command, args, options })
    return calls.length === 1 ? directFailure : retrySuccess
  }

  const result = spawnWithCmdFallback(
    "C:\\Program Files\\tool\\tool.cmd",
    ["--version", "a&b"],
    { encoding: "utf8" },
    { platform: "win32", spawnSync: fakeSpawnSync },
  )

  assert.equal(result, retrySuccess)
  assert.deepEqual(calls, [
    {
      command: "C:\\Program Files\\tool\\tool.cmd",
      args: ["--version", "a&b"],
      options: { encoding: "utf8" },
    },
    {
      command: '"C:\\Program Files\\tool\\tool.cmd" --version "a&b"',
      args: [],
      options: { encoding: "utf8", shell: true },
    },
  ])
})

test("spawnWithCmdFallback fails closed for percent expansion on Windows", () => {
  const calls: Array<{ command: string; args: string[]; options: object }> = []
  const directFailure = { error: Object.assign(new Error("invalid executable"), { code: "EINVAL" }) } as unknown as ReturnType<typeof nodeSpawnSync>
  const fakeSpawnSync = (command: string, args: string[], options: object) => {
    calls.push({ command, args, options })
    return directFailure
  }

  const result = spawnWithCmdFallback(
    "tool.cmd",
    ["%PATH%"],
    {},
    { platform: "win32", spawnSync: fakeSpawnSync },
  )

  assert.equal(result, directFailure)
  assert.equal(calls.length, 1)
})

test("homeDirectory prefers HOME over os.homedir()", () => {
  const original = process.env.HOME
  try {
    process.env.HOME = "/tmp/orchestra-fake-home"
    assert.equal(homeDirectory(), "/tmp/orchestra-fake-home")
    delete process.env.HOME
    assert.equal(homeDirectory(), os.homedir())
  } finally {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
  }
})
