// Exercises both actual React windows with a fake Tauri transport; no microphone,
// clipboard, global shortcut or user application is touched by this fixture.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "../voice-overlay/node_modules/vite/dist/node/index.js";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, ".cache/voice-widget-check");
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: path.join(root, "voice-overlay/vite.config.ts"),
  server: { host: "127.0.0.1", port: 1433, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--proxy-server=direct://", "--proxy-bypass-list=*"] });
  const context = await browser.newContext();
  const main = await context.newPage();
  const widget = await context.newPage();
  const pages = { overlay: main, "voice-widget": widget };
  const target = { window: 123, focus: 124, process: 42, title: "OpenCode fixture" };
  const calls = [];
  let snapshot = { enabled: false, status: "idle", elapsed: 0, blocked: true, pending: false, message: null };
  let transcript;
  let allowPaste = false;
  const emit = (label, event, payload) => pages[label].evaluate(({ event, payload }) => {
    window.__voiceFixture.emit(event, payload);
  }, { event, payload });
  await context.exposeBinding("voiceFixtureInvoke", async ({ page }, command, args) => {
    calls.push({ label: page === main ? "overlay" : "voice-widget", command, args });
    switch (command) {
      case "list_microphones": return ["Fixture microphone"];
      case "enable_voice_hotkey": return true;
      case "update_voice_widget":
        snapshot = args.snapshot;
        if (widget.url().startsWith("http")) await emit("voice-widget", "voice-widget-state", snapshot);
        return;
      case "voice_widget_snapshot": return snapshot;
      case "toggle_voice_widget": await emit("overlay", "voice-hotkey", target); return;
      case "start_recording": return true;
      case "stop_recording": return "fixture.wav";
      case "transcribe": return new Promise(resolve => { transcript = resolve; });
      case "paste_voice_text": assert.deepEqual(args.target, target); return allowPaste;
      case "attach_voice_window": return target.title;
      default: throw new Error(`Unexpected command ${command}`);
    }
  });
  for (const [label, page] of Object.entries(pages)) {
    await page.addInitScript(({ label }) => {
      Object.defineProperty(navigator, "platform", { value: "Win32" });
      window.isTauri = true;
      const callbacks = new Map();
      const listeners = new Map();
      let next = 0;
      window.__voiceFixture = {
        emit(event, payload) {
          for (const [id, item] of listeners) {
            if (item.event === event) callbacks.get(item.handler)?.({ event, id, payload });
          }
        },
      };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label } },
        transformCallback(callback) { const id = ++next; callbacks.set(id, callback); return id; },
        async invoke(command, args) {
          if (command === "plugin:event|listen") { const id = ++next; listeners.set(id, args); return id; }
          if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
          return window.voiceFixtureInvoke(command, args);
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(_event, id) { const item = listeners.get(id); if (item) callbacks.delete(item.handler); listeners.delete(id); },
      };
    }, { label });
  }
  await main.setViewportSize({ width: 360, height: 700 });
  await main.goto("http://127.0.0.1:1433", { waitUntil: "domcontentloaded" });
  await main.getByRole("switch", { name: "Микрофон поверх окна OpenCode" }).waitFor();
  await widget.setViewportSize({ width: 204, height: 76 });
  await widget.goto("http://127.0.0.1:1433", { waitUntil: "domcontentloaded" });
  await widget.getByRole("button", { name: "Начать запись", exact: true }).click();
  await widget.getByRole("button", { name: "Остановить запись" }).waitFor();
  await widget.waitForFunction(() => document.body.innerText.includes("0:01"));
  await widget.screenshot({ path: path.join(output, "recording.png"), omitBackground: true });
  await main.screenshot({ path: path.join(output, "main.png") });
  await widget.getByRole("button", { name: "Остановить запись" }).click();
  const processing = widget.getByRole("button", { name: "Распознавание речи" });
  await processing.waitFor();
  assert.equal(await processing.isDisabled(), true);
  assert.equal(calls.filter(call => call.command === "start_recording").length, 1);
  assert.equal(calls.filter(call => call.command === "stop_recording").length, 1);
  assert.equal(typeof transcript, "function");
  transcript("Текст из прикреплённой кнопки");
  await widget.getByRole("button", { name: "Вставить сохранённый текст" }).waitFor();
  await main.getByRole("textbox", { name: "Распознанный текст — можно исправить" }).waitFor();
  allowPaste = true;
  await widget.getByRole("button", { name: "Вставить сохранённый текст" }).click();
  await widget.getByRole("button", { name: "Начать запись", exact: true }).waitFor();
  assert.equal(calls.filter(call => call.command === "start_recording").length, 1, "draft retry must not start a recorder");
  assert.equal(calls.filter(call => call.command === "paste_voice_text").length, 2);
  assert.equal(calls.some(call => /submit|send_to_session/.test(call.command)), false);
  await main.getByRole("switch", { name: "Микрофон поверх окна OpenCode" }).uncheck();
  await widget.waitForFunction(() => document.querySelector("button").disabled);
  await main.reload();
  assert.equal(await main.getByRole("switch", { name: "Микрофон поверх окна OpenCode" }).isChecked(), false);
  console.log("PASS: widget start/stop, timer, processing lock, draft retry, manual submission and persisted visibility.");
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
