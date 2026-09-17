import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SECONDS,
  SAMPLE_RATE,
  ffmpegInputArgs,
  ffmpegOutputArgs,
  parseDshowDevices,
  parsePulseSources,
} from "../src/lib/audio.js";

const DSHOW_SAMPLE = [
  "[dshow @ 0x123] DirectShow audio devices",
  "[dshow @ 0x123]  \"Microphone (Realtek Audio)\" (audio)",
  "[dshow @ 0x123]  \"Headset (Hands-Free)\" (audio)",
  "[dshow @ 0x123]  \"Integrated Camera\" (video)",
].join("\n");

describe("parseDshowDevices", () => {
  it("returns only audio devices in listing order", () => {
    assert.deepEqual(parseDshowDevices(DSHOW_SAMPLE), [
      "Microphone (Realtek Audio)",
      "Headset (Hands-Free)",
    ]);
  });
  it("returns empty array when no audio devices", () => {
    assert.deepEqual(parseDshowDevices("dummy output"), []);
  });
});

describe("parsePulseSources", () => {
  it("returns recording sources and skips output monitors", () => {
    assert.deepEqual(
      parsePulseSources([
        "Auto-detected sources for pulse:",
        "  RDPSink.monitor [Monitor of RDP Sink] (none)",
        "* RDPSource [RDP Source] (none)",
        "  alsa_input.usb-GK50 [GK50 microphone] (none)",
      ].join("\n")),
      ["RDPSource", "alsa_input.usb-GK50"],
    );
  });
});

describe("ffmpegInputArgs", () => {
  it("linux pulse default", () => {
    assert.deepEqual(ffmpegInputArgs("linux", undefined), ["-f", "pulse", "-i", "default"]);
  });
  it("linux honors explicit device", () => {
    assert.deepEqual(ffmpegInputArgs("linux", "hw:1"), ["-f", "pulse", "-i", "hw:1"]);
  });
  it("windows dshow with device name", () => {
    assert.deepEqual(ffmpegInputArgs("win32", "Microphone (Realtek Audio)"), [
      "-f", "dshow", "-i", "audio=Microphone (Realtek Audio)",
    ]);
  });
  it("requires a resolved Windows microphone instead of guessing an unsupported input", () => {
    assert.throws(() => ffmpegInputArgs("win32", undefined), /no-mic/);
  });
});

describe("recording profile", () => {
  it("16kHz mono with 120s cap", () => {
    assert.equal(SAMPLE_RATE, 16000);
    assert.equal(MAX_SECONDS, 120);
    assert.deepEqual(ffmpegOutputArgs("audio.wav").slice(0, 2), ["-t", "120"]);
  });
});
