const { spawnSync } = require("node:child_process")
const { readFileSync } = require("node:fs")
const { dirname, resolve } = require("node:path")

const variants = {
  android: { arm64: "android-arm64" },
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  freebsd: { x64: "freebsd-x64" },
  linux: {
    arm: "linux-arm-gnueabihf",
    arm64: "linux-arm64-gnu",
    x64: "linux-x64-gnu",
  },
  win32: { arm64: "win32-arm64-msvc", x64: "win32-x64-msvc" },
}

if (process.platform === "linux") {
  try {
    const { MUSL, familySync } = require("detect-libc")
    if (familySync() === MUSL && (process.arch === "arm64" || process.arch === "x64")) {
      variants.linux[process.arch] = `linux-${process.arch}-musl`
    }
  } catch {}
}

const variant = variants[process.platform]?.[process.arch]
if (!variant) {
  console.error(`Unsupported Lightning CSS platform: ${process.platform}-${process.arch}`)
  process.exit(1)
}

const packageName = `lightningcss-${variant}`
try {
  require.resolve(packageName)
  process.exit(0)
} catch {}

// package.json is intentionally not exported by lightningcss. Resolve its public
// entry point, then read the adjacent package metadata directly.
const lightningEntry = require.resolve("lightningcss")
const packagePath = resolve(dirname(lightningEntry), "../package.json")
const { version } = JSON.parse(readFileSync(packagePath, "utf8"))
console.log(`Installing missing optional dependency ${packageName}@${version}...`)
const npmArgs = ["install", "--no-save", "--include=optional", `${packageName}@${version}`]
// Recent Node versions do not execute .cmd shims directly with spawnSync on
// Windows. Invoke the shim through cmd.exe without enabling a shell elsewhere.
const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm"
const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...npmArgs] : npmArgs
const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: false,
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
