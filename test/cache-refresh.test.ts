import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { refreshPluginCache, type RefreshInstaller } from "../src/cache-refresh.js"

const PACKAGE_NAME = "@oeronteros-1/opencode-orchestra"
const TARGET = "1.0.22"

async function seedPackage(packagesRoot: string, spec: string, resolvedVersion: string | undefined): Promise<string> {
  const directory = path.join(packagesRoot, "@oeronteros-1", `opencode-orchestra${spec ? `@${spec}` : ""}`)
  await mkdir(path.join(directory, "node_modules", PACKAGE_NAME), { recursive: true })
  if (resolvedVersion !== undefined) {
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ dependencies: { [PACKAGE_NAME]: resolvedVersion } }, null, 2)}\n`,
    )
    await writeFile(
      path.join(directory, "node_modules", PACKAGE_NAME, "package.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version: resolvedVersion })}\n`,
    )
  }
  return directory
}

function fakeInstaller(version: string): RefreshInstaller {
  return async (directory: string) => {
    await writeFile(
      path.join(directory, "node_modules", PACKAGE_NAME, "package.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version })}\n`,
    )
    return true
  }
}

function failingInstaller(): RefreshInstaller {
  return async () => false
}

test("refresh reinstalls a stale @latest cache entry in place and rewrites its pin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  const directory = await seedPackage(root, "latest", "1.0.8")
  const installerCalls: string[] = []

  const report = await refreshPluginCache({
    packagesRoot: root,
    targetVersion: TARGET,
    runInstaller: async (dir) => {
      installerCalls.push(dir)
      return fakeInstaller(TARGET)(dir)
    },
  })

  assert.deepEqual(report.upToDate, [])
  assert.deepEqual(report.invalidated, [])
  assert.deepEqual(report.reinstalled, ["@oeronteros-1/opencode-orchestra@latest"])
  assert.deepEqual(installerCalls, [directory])
  const pin = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  assert.equal(pin.dependencies[PACKAGE_NAME], TARGET)
  const resolved = JSON.parse(await readFile(path.join(directory, "node_modules", PACKAGE_NAME, "package.json"), "utf8")) as { version: string }
  assert.equal(resolved.version, TARGET)
})

test("refresh reports an up-to-date mutable entry without invoking the installer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  await seedPackage(root, "latest", TARGET)

  const report = await refreshPluginCache({
    packagesRoot: root,
    targetVersion: TARGET,
    runInstaller: async () => {
      throw new Error("installer must not run for up-to-date entries")
    },
  })

  assert.deepEqual(report, { upToDate: ["@oeronteros-1/opencode-orchestra@latest"], reinstalled: [], invalidated: [] })
})

test("refresh leaves exact semver pins alone even when their version differs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  await seedPackage(root, "1.0.15", "1.0.15")
  await seedPackage(root, "1.0.6", "1.0.6")

  const report = await refreshPluginCache({
    packagesRoot: root,
    targetVersion: TARGET,
    runInstaller: failingInstaller(),
  })

  assert.deepEqual(report, { upToDate: [], reinstalled: [], invalidated: [] })
})

test("refresh treats a bare-name directory (no @suffix) as a mutable latest-style spec", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  const directory = path.join(root, PACKAGE_NAME)
  await mkdir(path.join(directory, "node_modules", PACKAGE_NAME), { recursive: true })
  await writeFile(
    path.join(directory, "node_modules", PACKAGE_NAME, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, version: "0.5.1" })}\n`,
  )

  const report = await refreshPluginCache({
    packagesRoot: root,
    targetVersion: TARGET,
    runInstaller: fakeInstaller(TARGET),
  })

  assert.deepEqual(report.reinstalled, [PACKAGE_NAME])
  const pin = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  assert.equal(pin.dependencies[PACKAGE_NAME], TARGET)
})

test("refresh invalidates the directory when no package manager can update it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  const directory = await seedPackage(root, "latest", "1.0.8")

  const report = await refreshPluginCache({
    packagesRoot: root,
    targetVersion: TARGET,
    runInstaller: failingInstaller(),
  })

  assert.deepEqual(report.reinstalled, [])
  assert.deepEqual(report.invalidated, ["@oeronteros-1/opencode-orchestra@latest"])
  await assert.rejects(stat(directory), { code: "ENOENT" })
})

test("refresh repairs a corrupt entry when possible and removes it otherwise", async () => {
  const repairRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  await seedPackage(repairRoot, "latest", undefined)

  const repairedReport = await refreshPluginCache({
    packagesRoot: repairRoot,
    targetVersion: TARGET,
    runInstaller: fakeInstaller(TARGET),
  })
  assert.deepEqual(repairedReport.reinstalled, ["@oeronteros-1/opencode-orchestra@latest"])
  assert.deepEqual(repairedReport.invalidated, [])

  const removeRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"))
  const directory = await seedPackage(removeRoot, "latest", undefined)
  const removedReport = await refreshPluginCache({
    packagesRoot: removeRoot,
    targetVersion: TARGET,
    runInstaller: failingInstaller(),
  })
  assert.deepEqual(removedReport.reinstalled, [])
  assert.deepEqual(removedReport.invalidated, ["@oeronteros-1/opencode-orchestra@latest"])
  await assert.rejects(stat(directory), { code: "ENOENT" })
})

test("refresh ignores unrelated packages and a missing packages root", async () => {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-empty-"))
  const missingRoot = path.join(emptyRoot, "does-not-exist")

  const missingReport = await refreshPluginCache({
    packagesRoot: missingRoot,
    targetVersion: TARGET,
    runInstaller: failingInstaller(),
  })
  assert.deepEqual(missingReport, { upToDate: [], reinstalled: [], invalidated: [] })

  const foreignRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-foreign-"))
  // Windows forbids ":" in file names, so the git-spec-shaped Superpowers
  // entry cannot exist as a directory there; a scoped foreign package
  // exercises the same "unrelated entries stay untouched" guarantee.
  const foreignPackage = path.join(foreignRoot, "@acme", "other-plugin@latest")
  await mkdir(foreignPackage, { recursive: true })
  await writeFile(path.join(foreignPackage, "marker.txt"), "keep me")
  const lookalike = path.join(foreignRoot, "@someone", "opencode-orchestra@latest")
  await mkdir(lookalike, { recursive: true })
  const foreignReport = await refreshPluginCache({
    packagesRoot: foreignRoot,
    targetVersion: TARGET,
    runInstaller: failingInstaller(),
  })
  assert.deepEqual(foreignReport, { upToDate: [], reinstalled: [], invalidated: [] })
  assert.equal(await readFile(path.join(foreignPackage, "marker.txt"), "utf8"), "keep me")
})

test("dry-run classifies stale entries without touching the cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestra-cache-dryrun-"))
  const directory = await seedPackage(root, "latest", "1.0.8")

  const report = await refreshPluginCache({
    packagesRoot: root,
    targetVersion: TARGET,
    dryRun: true,
    runInstaller: async () => {
      throw new Error("installer must not run during a dry run")
    },
  })

  assert.deepEqual(report, { upToDate: [], reinstalled: ["@oeronteros-1/opencode-orchestra@latest"], invalidated: [] })
  const pin = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  assert.equal(pin.dependencies[PACKAGE_NAME], "1.0.8")
  const resolved = JSON.parse(await readFile(path.join(directory, "node_modules", PACKAGE_NAME, "package.json"), "utf8")) as { version: string }
  assert.equal(resolved.version, "1.0.8")
})
