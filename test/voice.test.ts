import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { voiceBinaryName, voiceManagedDir, voiceModelDir, voiceOverlayPackageFor, voiceOverlayTriple, VOICE_MODEL_URL } from "../src/voice.js"

describe("voiceOverlayPackageFor", () => {
  it("maps supported platforms to sidecar package names", () => {
    assert.equal(voiceOverlayPackageFor("linux", "x64"), "@oeronteros-1/voice-overlay-linux-x64")
    assert.equal(voiceOverlayPackageFor("linux", "arm64"), "@oeronteros-1/voice-overlay-linux-arm64")
    assert.equal(voiceOverlayPackageFor("win32", "x64"), "@oeronteros-1/voice-overlay-win32-x64")
  })
  it("returns null for unsupported platforms", () => {
    assert.equal(voiceOverlayPackageFor("darwin", "arm64"), null)
    assert.equal(voiceOverlayPackageFor("win32", "arm64"), null)
    assert.equal(voiceOverlayPackageFor("freebsd", "x64"), null)
  })
})

describe("VOICE_MODEL_URL", () => {
  it("points at the whisper.cpp ggml base model", () => {
    assert.equal(VOICE_MODEL_URL, "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin")
  })
})

describe("voiceBinaryName", () => {
  it("adds .exe on Windows only", () => {
    assert.equal(voiceBinaryName("win32"), "voice-overlay.exe")
    assert.equal(voiceBinaryName("linux"), "voice-overlay")
  })
})

describe("voiceOverlayTriple", () => {
  it("mirrors the Rust sidecar_file triples", () => {
    assert.equal(voiceOverlayTriple("linux", "x64"), "x86_64-unknown-linux-gnu")
    assert.equal(voiceOverlayTriple("linux", "arm64"), "aarch64-unknown-linux-gnu")
    assert.equal(voiceOverlayTriple("win32", "x64"), "x86_64-pc-windows-msvc.exe")
  })
  it("returns null where no sidecar package exists", () => {
    assert.equal(voiceOverlayTriple("darwin", "arm64"), null)
    assert.equal(voiceOverlayTriple("win32", "arm64"), null)
  })
})

describe("voiceManagedDir", () => {
  it("uses ~/.local/bin on Linux", () => {
    assert.equal(voiceManagedDir("linux", { HOME: "/home/u" }), "/home/u/.local/bin")
  })
  it("uses LOCALAPPDATA Programs dir on Windows", () => {
    assert.equal(
      voiceManagedDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }),
      "C:\\Users\\u\\AppData\\Local/Programs/voice-overlay",
    )
  })
  it("returns null when the home base is missing or unsupported", () => {
    assert.equal(voiceManagedDir("linux", {}), null)
    assert.equal(voiceManagedDir("win32", {}), null)
    assert.equal(voiceManagedDir("darwin", { HOME: "/Users/u" }), null)
  })
})

describe("voiceModelDir", () => {
  it("uses XDG_DATA_HOME on Linux when set", () => {
    assert.equal(
      voiceModelDir("linux", { XDG_DATA_HOME: "/xdg", HOME: "/home/u" }),
      "/xdg/ai.opencode.voice-overlay/models",
    )
  })
  it("falls back to ~/.local/share on Linux", () => {
    assert.equal(
      voiceModelDir("linux", { HOME: "/home/u" }),
      "/home/u/.local/share/ai.opencode.voice-overlay/models",
    )
  })
  it("uses APPDATA on Windows", () => {
    assert.equal(
      voiceModelDir("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }),
      "C:\\Users\\u\\AppData\\Roaming/ai.opencode.voice-overlay/models",
    )
  })
  it("returns null when the base is missing or unsupported", () => {
    assert.equal(voiceModelDir("linux", {}), null)
    assert.equal(voiceModelDir("win32", {}), null)
    assert.equal(voiceModelDir("darwin", { HOME: "/Users/u" }), null)
  })
})
