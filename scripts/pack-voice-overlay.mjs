#!/usr/bin/env node
// Stage a voice-overlay sidecar npm package: copy the built Tauri binary +
// ffmpeg/whisper sidecars into voice-overlay/packaging/<platform>/, stamp the
// version from the root package.json (lockstep), print the publish command.
// Runs in CI only (needs a real `tauri build` output in --src).
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PLATFORMS = {
  "linux-x64": {
    binary: "voice-overlay",
    sidecars: ["ffmpeg-x86_64-unknown-linux-gnu", "whisper-x86_64-unknown-linux-gnu"],
    // whisper-cli needs its .so libs co-located (RUNPATH=$ORIGIN); the exact
    // set varies per release (libwhisper, libggml*, libparakeet, versioned).
    libs: ["lib*.so*"],
  },
  "linux-arm64": {
    binary: "voice-overlay",
    sidecars: ["ffmpeg-aarch64-unknown-linux-gnu", "whisper-aarch64-unknown-linux-gnu"],
    libs: ["lib*.so*"],
  },
  "win32-x64": {
    binary: "voice-overlay.exe",
    sidecars: ["ffmpeg-x86_64-pc-windows-msvc.exe", "whisper-x86_64-pc-windows-msvc.exe"],
    libs: ["*.dll"],
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
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const dest = path.join(repoRoot, "voice-overlay", "packaging", platform)
  await mkdir(dest, { recursive: true })
  // Tauri removes target triples from externalBin names and puts resources
  // in bundle-specific directories. Stage the original vendored files instead.
  const sidecarDir = path.join(repoRoot, "voice-overlay", "src-tauri", "binaries")
  const available = new Set(await readdir(sidecarDir))
  const matchGlob = (pattern) => {
    const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
    return [...available].filter((f) => regex.test(f)).sort()
  }
  await copyFile(path.join(src, spec.binary), path.join(dest, spec.binary))
  const files = [...spec.sidecars]
  for (const pattern of spec.libs) {
    const matched = matchGlob(pattern)
    if (matched.length === 0) throw new Error(`No files in ${sidecarDir} match lib pattern ${pattern}`)
    files.push(...matched)
  }
  for (const file of files) {
    if (!available.has(file)) throw new Error(`Missing build artifact ${file} in ${sidecarDir}`)
    await copyFile(path.join(sidecarDir, file), path.join(dest, file))
  }
  const manifestPath = path.join(dest, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.version = version
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Staged ${manifest.name}@${version} from ${src}`)
  console.log(`Publish with: npm publish --access public ${dest}`)
}

await main()
