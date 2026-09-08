#!/usr/bin/env node
// Set Tauri bundle.resources per OS: tauri-build fails the whole build when
// ANY resource glob matches nothing, so Linux (*.so) and Windows (*.dll)
// need different lists. CI calls this with --platform before `tauri build`;
// local devs run it bare (current OS is auto-detected).
// Usage: node scripts/tauri-resources.mjs [--platform <linux-x64|linux-arm64|win32-x64>] [--config <path>]
import { readFile, writeFile } from "node:fs/promises"

const RESOURCES = {
  linux: ["binaries/*.so", "binaries/*.so.*"],
  win32: ["binaries/*.dll"],
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value !== undefined && !value.startsWith("--")) return value
  return undefined
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/tauri-resources.mjs [--platform <linux-x64|linux-arm64|win32-x64>] [--config <path>]")
    return
  }
  const platform = arg("platform") ?? (process.platform === "win32" ? "win32-x64" : "linux-x64")
  const os = platform.startsWith("win32") ? "win32" : "linux"
  const configPath = arg("config") ?? "voice-overlay/src-tauri/tauri.conf.json"
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.bundle = config.bundle ?? {}
  config.bundle.resources = RESOURCES[os]
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`resources for ${platform}: ${RESOURCES[os].join(", ")}`)
}

await main()
