import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSendResult,
  parseSessionList,
  sessionListRequest,
  sessionMessageRequest,
} from "../src/lib/opencode.js";

const CFG = { host: "127.0.0.1", port: 4096, username: "", password: "" };

describe("sessionListRequest", () => {
  it("GETs /session with JSON content type", () => {
    const req = sessionListRequest(CFG);
    assert.equal(req.url, "http://127.0.0.1:4096/session");
    assert.equal(req.method, "GET");
    assert.equal(req.headers["Content-Type"], "application/json");
  });
});

describe("sessionMessageRequest", () => {
  it("POSTs text part to prompt_async (204, no wait)", () => {
    const req = sessionMessageRequest(CFG, "ses_123", "привет");
    assert.equal(req.url, "http://127.0.0.1:4096/session/ses_123/prompt_async");
    assert.equal(req.method, "POST");
    assert.equal(req.body, JSON.stringify({ parts: [{ type: "text", text: "привет" }] }));
  });
  it("URL-encodes the session id", () => {
    const req = sessionMessageRequest(CFG, "a/b c", "x");
    assert.ok(req.url.includes("/session/a%2Fb%20c/prompt_async"), req.url);
  });
});

describe("parseSessionList", () => {
  it("extracts id+title, falls back to id", () => {
    assert.deepEqual(
      parseSessionList([{ id: "s1", title: "Shop" }, { id: "s2" }]),
      [{ id: "s1", title: "Shop" }, { id: "s2", title: "s2" }],
    );
  });
  it("rejects non-arrays and items without id", () => {
    assert.deepEqual(parseSessionList({}), []);
    assert.deepEqual(parseSessionList([{ title: "x" }]), []);
    assert.deepEqual(parseSessionList(null), []);
  });
});

describe("parseSendResult", () => {
  it("2xx -> sent", () => {
    assert.equal(parseSendResult(200), "sent");
    assert.equal(parseSendResult(204), "sent");
  });
  it("401/403 -> unauthorized, 404 -> session-not-found", () => {
    assert.equal(parseSendResult(401), "unauthorized");
    assert.equal(parseSendResult(403), "unauthorized");
    assert.equal(parseSendResult(404), "session-not-found");
  });
  it("rest -> fallback", () => {
    assert.equal(parseSendResult(500), "fallback");
    assert.equal(parseSendResult(0), "fallback");
  });
});
