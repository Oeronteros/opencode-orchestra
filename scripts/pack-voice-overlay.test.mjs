import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

for (const [platform, binary, sidecars] of [
  ["linux-x64", "voice-overlay", ["ffmpeg-x86_64-unknown-linux-gnu", "whisper-x86_64-unknown-linux-gnu", "libwhisper.so", "libwhisper.so.1", "libggml-cpu.so"]],
  ["win32-x64", "voice-overlay.exe", ["ffmpeg-x86_64-pc-windows-msvc.exe", "whisper-x86_64-pc-windows-msvc.exe", "whisper.dll", "ggml-cpu.dll"]],
]) {
  test(`stage ${platform} from Tauri output and original sidecars`, async () => {
    // Spaces and non-ASCII characters exercise file URL decoding on both OSes.
    const root = await mkdtemp(path.join(os.tmpdir(), "voice package тест "))
    try {
      const scripts = path.join(root, "scripts")
      const src = path.join(root, "voice-overlay", "src-tauri", "target", "release")
      const vendor = path.join(root, "voice-overlay", "src-tauri", "binaries")
      const dest = path.join(root, "voice-overlay", "packaging", platform)
      for (const dir of [scripts, src, vendor, dest]) await mkdir(dir, { recursive: true })
      const script = path.join(scripts, "pack-voice-overlay.mjs")
      await copyFile(new URL("./pack-voice-overlay.mjs", import.meta.url), script)
      await writeFile(path.join(dest, "package.json"), JSON.stringify({ name: `test-${platform}`, version: "0.0.0" }))
      await writeFile(path.join(src, binary), "built application")
      for (const name of sidecars) await writeFile(path.join(vendor, name), `vendored ${name}`)
      await writeFile(path.join(vendor, "unrelated.txt"), "exclude")
      execFileSync(process.execPath, [script, "--platform", platform, "--version", "2.0.1", "--src", src], { cwd: os.tmpdir() })
      assert.deepEqual((await readdir(dest)).sort(), [binary, ...sidecars, "package.json"].sort())
      assert.equal(await readFile(path.join(dest, binary), "utf8"), "built application")
      for (const name of sidecars) assert.equal(await readFile(path.join(dest, name), "utf8"), `vendored ${name}`)
      assert.equal(JSON.parse(await readFile(path.join(dest, "package.json"), "utf8")).version, "2.0.1")
      await rm(path.join(vendor, sidecars[0]))
      assert.throws(() => execFileSync(process.execPath, [script, "--platform", platform, "--version", "2.0.1", "--src", src], { stdio: "pipe" }), /Missing build artifact/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
