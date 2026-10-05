import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { launchWslVoiceOverlay, prepareWslVoiceOverlay, resolveWslVoiceHost, usesWindowsVoiceHost, type WslCommand } from "../src/voice-wsl.js"

const folders = { local: "C:\\Users\\User 中文\\AppData\\Local", roaming: "C:\\Users\\User 中文\\AppData\\Roaming" }
const commands: Array<{ command: string; args: string[] }> = []
const run: WslCommand = async (command, args) => {
  commands.push({ command, args })
  if (command === "powershell.exe") return JSON.stringify(folders)
  assert.equal(command, "wslpath")
  assert.equal(args[0], "-u")
  return `/mnt/c/${args[1]!.slice(3).replaceAll("\\", "/")}`
}

describe("WSL window-attached voice host", () => {
  it("detects WSL1/WSL2 and honors explicit native Linux selection without changing ordinary Linux/Windows", () => {
    assert.equal(usesWindowsVoiceHost("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true)
    assert.equal(usesWindowsVoiceHost("linux", { WSL_INTEROP: "/run/WSL/123_interop" }, "linux"), true)
    assert.equal(usesWindowsVoiceHost("linux", {}, "6.6.87.2-microsoft-standard-WSL2"), true)
    assert.equal(usesWindowsVoiceHost("linux", {}, "4.4.0-Microsoft"), true)
    assert.equal(usesWindowsVoiceHost("linux", { ORCHESTRA_VOICE_LINUX_NATIVE: "1", WSL_DISTRO_NAME: "Ubuntu" }, "Microsoft"), false)
    assert.equal(usesWindowsVoiceHost("linux", {}, "6.12.0-generic"), false)
    assert.equal(usesWindowsVoiceHost("win32", { WSL_DISTRO_NAME: "Ubuntu" }, "Microsoft"), false)
  })

  it("locates the Windows user's actual directories and passes paths with spaces/Unicode as argv", async () => {
    commands.length = 0
    const host = await resolveWslVoiceHost({ env: {}, run })
    assert.equal(host.binary, "/mnt/c/Users/User 中文/AppData/Local/Programs/voice-overlay/voice-overlay.exe")
    assert.equal(host.modelDir, "/mnt/c/Users/User 中文/AppData/Roaming/ai.opencode.voice-overlay/models")
    assert.deepEqual(commands[1]?.args, ["-u", `${folders.local}\\Programs\\voice-overlay\\voice-overlay.exe`])
    assert.ok(commands[0]?.args.includes("-NoProfile"))
  })

  it("preserves explicit development builds including shell metacharacters without interpolating PowerShell", async () => {
    const binary = "/mnt/c/User Space/voice `$(literal)' 中文/voice-overlay.exe"
    let installed = false, modelDir = ""
    const host = await prepareWslVoiceOverlay({
      env: { ORCHESTRA_VOICE_WINDOWS_BINARY: binary }, run, packageDir: "do-not-install",
      exists: async () => true,
      install: async () => { installed = true; return true },
      ensureModel: async dir => { modelDir = dir },
    })
    assert.equal(host.binary, binary)
    assert.equal(installed, false)
    assert.equal(modelDir, host.modelDir)
    assert.ok(commands.filter(call => call.command === "powershell.exe").every(call => !call.args.join(" ").includes(binary)))
  })

  it("refreshes a supplied Windows companion and keeps sidecars/model on the Windows host", async () => {
    let installed: unknown[] = [], modelDir = ""
    const host = await prepareWslVoiceOverlay({
      env: {}, run, packageDir: "/package/windows",
      exists: async () => true,
      install: async (...args) => { installed = args; return true },
      ensureModel: async dir => { modelDir = dir },
    })
    assert.deepEqual(installed, ["/package/windows", "/mnt/c/Users/User 中文/AppData/Local/Programs/voice-overlay", "win32", "x64"])
    assert.equal(modelDir, host.modelDir)
  })

  it("reports incomplete Windows installs before downloading models, and gives actionable interop errors", async () => {
    let downloaded = false
    await assert.rejects(prepareWslVoiceOverlay({
      env: {}, run, packageDir: null, exists: async file => !file.includes("ffmpeg"),
      ensureModel: async () => { downloaded = true },
    }), /Windows voice-overlay installation is incomplete:.*ffmpeg/)
    assert.equal(downloaded, false)
    await assert.rejects(resolveWslVoiceHost({ run: async () => { throw new Error("ENOENT") } }), /Enable WSL interop/)
    await assert.rejects(resolveWslVoiceHost({ run: async () => "{}" }), /invalid.*directories/)
    await assert.rejects(resolveWslVoiceHost({ env: { ORCHESTRA_VOICE_WINDOWS_BINARY: "relative.exe" }, run }), /absolute/)
    await assert.rejects(resolveWslVoiceHost({ env: { ORCHESTRA_VOICE_WINDOWS_BINARY: "/bin/voice-overlay" }, run }), /absolute Windows .exe/)
    await assert.rejects(resolveWslVoiceHost({ run: async command => command === "powershell.exe" ? JSON.stringify(folders) : "relative/path" }), /non-absolute/)
  })

  it("launches the resolved host binary and reports failed interop instead of announcing success", async () => {
    let launched = ""
    const options = { env: {}, run, packageDir: null, exists: async () => true, ensureModel: async () => {} }
    await launchWslVoiceOverlay({ ...options, launch: async binary => { launched = binary } })
    assert.equal(launched, "/mnt/c/Users/User 中文/AppData/Local/Programs/voice-overlay/voice-overlay.exe")
    await assert.rejects(launchWslVoiceOverlay({ ...options, launch: async () => { throw new Error("Exec format error") } }), /Check WSL interop.*Exec format error/)
  })
})
