import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendRequest, basicAuthHeader, parseAppendResult } from "../src/lib/opencode.js";

describe("appendRequest", () => {
  it("builds the exact live-verified contract", () => {
    const req = appendRequest({ host: "127.0.0.1", port: 4096, username: "", password: "" }, "привет");
    assert.equal(req.url, "http://127.0.0.1:4096/tui/append-prompt");
    assert.equal(req.method, "POST");
    assert.equal(req.body, '{"text":"привет"}');
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.ok(!("Authorization" in req.headers));
  });
  it("adds Basic auth only when username is set", () => {
    const req = appendRequest({ host: "h", port: 1, username: "opencode", password: "s3cret" }, "x");
    assert.equal(req.headers["Authorization"], "Basic " + basicAuthHeader("opencode", "s3cret"));
  });
});

describe("basicAuthHeader", () => {
  it("base64-encodes user:pass", () => {
    assert.equal(basicAuthHeader("opencode", "s3cret"), Buffer.from("opencode:s3cret").toString("base64"));
  });
});

describe("parseAppendResult", () => {
  it("200 true -> inserted", () => {
    assert.equal(parseAppendResult(200, true), "inserted");
  });
  it("401/403 -> unauthorized", () => {
    assert.equal(parseAppendResult(401, false), "unauthorized");
    assert.equal(parseAppendResult(403, true), "unauthorized");
  });
  it("500, 200-false, transport-0 -> fallback", () => {
    assert.equal(parseAppendResult(500, false), "fallback");
    assert.equal(parseAppendResult(200, false), "fallback");
    assert.equal(parseAppendResult(0, false), "fallback");
  });
});
