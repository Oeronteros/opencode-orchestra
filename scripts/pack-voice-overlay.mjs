#!/usr/bin/env node
// Stage a voice-overlay sidecar npm package: copy the built Tauri binary +
// ffmpeg/whisper sidecars into voice-overlay/packaging/<platform>/, stamp the
// version from the root package.json (lockstep), print the publish command.
// Runs in CI only (needs a real `tauri build` output in --src).
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const PLATFORMS = {
  "linux-x64": {
    binary: "voice-overlay",
    sidecars: ["ffmpeg-x86_64-unknown-linux-gnu", "whisper-x86_64-unknown-linux-gnu"],
  },
  "linux-arm64": {
    binary: "voice-overlay",
    sidecars: ["ffmpeg-aarch64-unknown-linux-gnu", "whisper-aarch64-unknown-linux-gnu"],
  },
  "win32-x64": {
    binary: "voice-overlay.exe",
    sidecars: ["ffmpeg-x86_64-pc-windows-msvc.exe", "whisper-x86_64-pc-windows-msvc.exe"],
  },
}

function usage() {
  return [
    "Usage: node scripts/pack-voice-overlay.mjs --platform <linux-x64|linux-arm64|win32-x64> --version <x.y.z> --src <dir>",
    "",
    "Copies the built binary + sidecars into voice-overlay/packaging/<platform>/,",
    "stamps package.json version, and prints the npm publish command.",
  ].join("\n")
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing --${name} (see --help)`)
  return value
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage())
    return
  }
  const platform = arg("platform")
  const version = arg("version")
  const src = arg("src")
  const spec = PLATFORMS[platform]
  if (!spec) throw new Error(`Unknown --platform ${platform}; expected one of: ${Object.keys(PLATFORMS).join(", ")}`)
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const dest = path.join(repoRoot, "voice-overlay", "packaging", platform)
  await mkdir(dest, { recursive: true })
  for (const file of [spec.binary, ...spec.sidecars]) {
    await copyFile(path.join(src, file), path.join(dest, file))
  }
  const manifestPath = path.join(dest, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.version = version
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Staged ${manifest.name}@${version} from ${src}`)
  console.log(`Publish with: npm publish --access public ${dest}`)
}

await main()
