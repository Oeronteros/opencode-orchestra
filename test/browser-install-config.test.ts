import assert from "node:assert/strict"
import test from "node:test"
import { migrateBrowserConfig } from "../src/browser/install-config.js"

test("missing browser mode is enabled without deleting JSONC comments", () => {
  const result = migrateBrowserConfig('{\n // keep me\n "budget": "quality", "browser": {"headless":true}\n}', {})
  assert.equal(result.browser.mode, "auto")
  assert.equal(result.browser.headless, true)
  assert.match(result.text, /keep me/)
  assert.equal(migrateBrowserConfig(result.text, {}).changed, false)
})
test("explicit modes survive default install and CLI choices override", () => {
  assert.equal(migrateBrowserConfig('{"browser":{"mode":"off"}}', {}).browser.mode, "off")
  assert.equal(migrateBrowserConfig('{"browser":{"mode":"off"}}', { browserMode: "auto" }).browser.mode, "auto")
  assert.equal(migrateBrowserConfig('{}', { playwright: false }).browser.mode, "off")
  assert.throws(() => migrateBrowserConfig('{}', { playwright: false, browserMode: "auto" }), /conflicts/)
})
