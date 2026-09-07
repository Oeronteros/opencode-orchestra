import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, errorCopy } from "../src/lib/errors.js";

describe("error catalog", () => {
  it("every code has non-empty Russian copy", () => {
    for (const code of ERROR_CODES) {
      const copy = errorCopy(code);
      assert.ok(copy.length > 10, code);
      assert.match(copy, /[А-Яа-яЁё]/);
    }
  });
  it("catalog is exactly the spec-approved set", () => {
    assert.deepEqual([...ERROR_CODES].sort(), [
      "empty-recording", "empty-transcript", "model-missing", "no-audio-server",
      "no-ffmpeg", "no-mic", "no-session", "server-unreachable", "session-not-found",
      "too-long", "transcribe-failed", "unauthorized",
    ].sort());
  });
});
