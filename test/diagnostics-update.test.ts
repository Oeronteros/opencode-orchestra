import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  checkForUpdates,
  formatUpdateResult,
  isStableSemver,
  latestPublishedVersion,
} from "../src/diagnostics/update.js"

async function fakeCommand(directory: string, name: string, unixBody: string, windowsBody: string): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(path.join(directory, `${name}.cmd`), `@echo off\r\n${windowsBody}\r\n`, "utf8")
  } else {
    const file = path.join(directory, name)
    await writeFile(file, `#!/bin/sh\n${unixBody}\n`, "utf8")
    await chmod(file, 0o755)
  }
}

async function withToolchain(
  setup: (directory: string) => Promise<void>,
  callback: () => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-update-"))
  const previousPath = process.env.PATH
  try {
    await setup(directory)
    process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`
    await callback()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}

test("uses the npm registry CLI when npm succeeds", { concurrency: false }, async () => {
  await withToolchain(
    async (directory) => {
      await fakeCommand(directory, "npm", 'printf "2.3.4\\n"', "@echo 2.3.4")
      await fakeCommand(directory, "bun", "exit 1", "@exit /b 1")
    },
    async () => assert.equal(await latestPublishedVersion(), "2.3.4"),
  )
})

test("falls back to Bun when npm fails", { concurrency: false }, async () => {
  await withToolchain(
    async (directory) => {
      await fakeCommand(directory, "npm", "exit 1", "@exit /b 1")
      await fakeCommand(directory, "bun", 'printf "2.3.5\\n"', "@echo 2.3.5")
    },
    async () => assert.equal(await latestPublishedVersion(), "2.3.5"),
  )
})

test("falls back to the registry fetch after npm and Bun fail", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response("offline", { status: 500 })
    await withToolchain(
      async (directory) => {
        await fakeCommand(directory, "npm", "exit 1", "@exit /b 1")
        await fakeCommand(directory, "bun", "exit 1", "@exit /b 1")
      },
      async () => assert.equal(await latestPublishedVersion(), undefined),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("rejects invalid semver registry data", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "1.2.3-not-semver" }), { status: 200 })
    await withToolchain(
      async (directory) => {
        await fakeCommand(directory, "npm", "exit 1", "@exit /b 1")
        await fakeCommand(directory, "bun", "exit 1", "@exit /b 1")
      },
      async () => assert.equal(await latestPublishedVersion(), undefined),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("does not compare pre-release current versions as stable", () => {
  assert.equal(isStableSemver("1.2.3-beta.1"), false)
  assert.match(formatUpdateResult({ current: "1.2.3-beta.1", latest: "1.2.4" }), /Latest published version: 1\.2\.4/)
})

test("preserves the update result interface when lookup fails", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response("offline", { status: 500 })
    await withToolchain(
      async (directory) => {
        await fakeCommand(directory, "npm", "exit 1", "@exit /b 1")
        await fakeCommand(directory, "bun", "exit 1", "@exit /b 1")
      },
      async () => assert.deepEqual(await checkForUpdates("1.0.0"), { current: "1.0.0" }),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("update lookup routes npm/bun through the cmd-fallback spawn helper", async () => {
  // `latestPublishedVersion` has no injection seam (its public contract is a
  // zero-arg Promise), so we assert the runtime wiring: the module must use the
  // repo's spawnWithCmdFallback (which retries .cmd/.bat shims through cmd.exe
  // on Windows) and must not call node:child_process spawnSync directly, since
  // raw spawnSync cannot execute .cmd/.bat shims on patched Windows.
  const source = await readFile(fileURLToPath(new URL("../../src/diagnostics/update.ts", import.meta.url)), "utf8")
  assert.match(source, /import \{ spawnWithCmdFallback \} from "\.\.\/spawn\.js"/)
  assert.doesNotMatch(source, /import \{ spawnSync \} from "node:child_process"/)
})
