import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoInsertDefault, hotkeyAction, nativeInputDefault, parseVoiceDraft } from "../src/lib/hotkey.js";

describe("one voice shortcut", () => {
  it("toggles recording, retains failed insertion for retry and ignores in-flight operations", () => {
    assert.equal(hotkeyAction("idle", false, false), "start");
    assert.equal(hotkeyAction("recording", false, false), "stop");
    assert.equal(hotkeyAction("error", false, true), "retry");
    assert.equal(hotkeyAction("idle", false, true), "retry");
    for (const status of ["idle", "recording", "error"]) assert.equal(hotkeyAction(status, true, true), "ignore");
    assert.equal(hotkeyAction("transcribing", false, true), "ignore");
  });

  it("defaults Windows and Linux to V2 input and automatic insertion while preserving explicit choices", () => {
    assert.equal(nativeInputDefault("Win32", undefined), true);
    assert.equal(nativeInputDefault("Win32", false), false);
    assert.equal(nativeInputDefault("Linux x86_64", undefined), true);
    assert.equal(nativeInputDefault("Linux x86_64", false), false);
    assert.equal(nativeInputDefault("MacIntel", undefined), false);
    assert.equal(autoInsertDefault(undefined), true);
    assert.equal(autoInsertDefault(false), false);
    assert.equal(autoInsertDefault(true), true);
  });

  it("restores unsent text with its original target and rejects malformed storage", () => {
    const target = { window: 123, focus: 124, process: 10, title: "OpenCode" };
    assert.deepEqual(parseVoiceDraft({ text: "Черновик", target }), { text: "Черновик", target });
    assert.deepEqual(parseVoiceDraft({ text: "Из кнопки", target: null }), { text: "Из кнопки", target: null });
    for (const bad of [null, {}, { text: "", target }, { text: "x", target: { ...target, process: "10" } }, { text: "x", target: { ...target, window: Infinity } }]) assert.equal(parseVoiceDraft(bad), null);
  });
});
