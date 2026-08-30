import assert from "node:assert/strict"
import { spawnSync as nodeSpawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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

test("spawnWithCmdFallback shells out when a bare name resolves to a .cmd shim", async () => {
  // Patched Windows Node skips .cmd/.bat candidates when resolving a direct
  // spawn, so a .cmd shim in an earlier PATH entry would otherwise be
  // shadowed by a real .exe further down PATH (e.g. a fake `bun.cmd` losing
  // to a real `bun.exe`). The first PATH candidate must win, like cmd.exe
  // resolves it, and be executed through the shell without a doomed direct
  // attempt.
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-spawn-shim-"))
  try {
    await writeFile(path.join(directory, "bun.CMD"), "@echo off\r\n@echo 2.3.5\r\n", "utf8")
    const calls: Array<{ command: string; args: string[]; options: object }> = []
    const shellSuccess = { status: 0, signal: null, output: [], stdout: "2.3.5", stderr: "" } as unknown as ReturnType<typeof nodeSpawnSync>
    const fakeSpawnSync = (command: string, args: string[], options: object) => {
      calls.push({ command, args, options })
      return shellSuccess
    }
    const env = { ...process.env, PATH: directory }

    const result = spawnWithCmdFallback(
      "bun",
      ["pm", "view", "pkg", "version"],
      { encoding: "utf8", env },
      { platform: "win32", spawnSync: fakeSpawnSync },
    )

    assert.equal(result, shellSuccess)
    assert.deepEqual(calls, [
      {
        command: "bun pm view pkg version",
        args: [],
        options: { encoding: "utf8", env, shell: true },
      },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("spawnWithCmdFallback does not re-run the shim when the shell spawn fails", async () => {
  // Regression: a failed shell spawn used to fall through to the direct spawn
  // and then the generic retry, executing the .cmd shim twice. The shell
  // attempt must happen at most once per invocation.
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-spawn-shim-"))
  try {
    await writeFile(path.join(directory, "bun.CMD"), "@echo off\r\n@echo 2.3.5\r\n", "utf8")
    const shellError = { status: null, error: new Error("spawn cmd ENOENT") } as unknown as ReturnType<typeof nodeSpawnSync>
    const directError = { status: null, error: new Error("spawn bun EINVAL") } as unknown as ReturnType<typeof nodeSpawnSync>
    const calls: string[] = []
    const fakeSpawnSync = (command: string, _args: string[], options: object) => {
      calls.push(command)
      return (options as { shell?: boolean }).shell ? shellError : directError
    }
    const env = { ...process.env, PATH: directory }

    const result = spawnWithCmdFallback(
      "bun",
      ["--version"],
      { encoding: "utf8", env },
      { platform: "win32", spawnSync: fakeSpawnSync },
    )

    assert.equal(result, directError)
    assert.deepEqual(
      calls.filter((command) => command.includes(" ")),
      ["bun --version"],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("spawnWithCmdFallback resolves the shim against a URL cwd", async () => {
  // Regression: a URL cwd used to resolve shims against process.cwd() instead
  // of the URL's directory, so a shim in the URL directory was missed.
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-spawn-urldir-"))
  try {
    await writeFile(path.join(directory, "bun.CMD"), "@echo off\r\n@echo 2.3.5\r\n", "utf8")
    const shellSuccess = { status: 0, signal: null, output: [], stdout: "2.3.5", stderr: "" } as unknown as ReturnType<typeof nodeSpawnSync>
    const calls: string[] = []
    const fakeSpawnSync = (command: string) => {
      calls.push(command)
      return shellSuccess
    }
    // Empty PATH: the shim can only be found via the cwd entry.
    const env = { ...process.env, PATH: "" }
    const cwdUrl = new URL(`file://${directory.replace(/\\/g, "/")}`)

    const result = spawnWithCmdFallback(
      "bun",
      ["--version"],
      { encoding: "utf8", env, cwd: cwdUrl },
      { platform: "win32", spawnSync: fakeSpawnSync },
    )

    assert.equal(result, shellSuccess)
    assert.deepEqual(calls, ["bun --version"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
