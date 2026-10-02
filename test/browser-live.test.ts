import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { chromium } from "@playwright/test"
import { BrowserManager, chromeExecutable } from "../src/browser/manager.js"
import { backendCommand } from "../src/browser/packages.js"
import { browserConfigSchema } from "../src/config/schema.js"
import { browserFixture } from "./fixtures/browser-site.js"

const live = process.env.ORCHESTRA_LIVE_BROWSER === "1"
const executable = await chromeExecutable(process.env.ORCHESTRA_TEST_CHROME)
test("live: two pinned MCPs share one managed persistent fixture profile", { skip: !live ? "ORCHESTRA_LIVE_BROWSER is not enabled" : !executable ? "Chrome is missing; set ORCHESTRA_TEST_CHROME to a Chrome executable" : false, timeout: 120000 }, async () => {
  const fixture = await browserFixture()
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestra-live-browser-"))
  const config = browserConfigSchema.parse({ mode: "auto", executable, headless: true })
  const manager = new BrowserManager(path.join(directory, "test-only-profile"), config)
  const clients: Client[] = []
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
  try {
    assert.equal(manager.running, false)
    const endpoint = await manager.start()
    const pid = manager.pid
    browser = await chromium.connectOverCDP(endpoint)
    const page = browser.contexts()[0]!.pages()[0]!
    await page.goto(fixture.origin)
    await page.getByRole("button", { name: "Sign in" }).click()
    await page.getByText("signed-in", { exact: true }).waitFor()
    const connect = async (backend: "playwright" | "devtools") => {
      const [command, ...args] = backendCommand(backend, endpoint, config, directory)
      const transport = new StdioClientTransport({ command: command!, args, cwd: directory, stderr: "pipe", env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } })
      const client = new Client({ name: "orchestra-local-fixture", version: "1" })
      clients.push(client)
      await client.connect(transport)
      return client
    }
    const playwright = await connect("playwright")
    const pwSnapshot = await playwright.callTool({ name: "browser_snapshot", arguments: {} })
    assert.equal(pwSnapshot.isError, undefined)
    assert.match(JSON.stringify(pwSnapshot), /signed-in/)
    const devtools = await connect("devtools")
    const dtSnapshot = await devtools.callTool({ name: "take_snapshot", arguments: {} })
    assert.equal(dtSnapshot.isError, undefined)
    assert.match(JSON.stringify(dtSnapshot), /signed-in/)
    assert.equal(manager.pid, pid)
    assert.equal((await manager.targets()).filter((target) => target.type === "page").length, 1)
    await devtools.callTool({ name: "list_network_requests", arguments: {} })
    await page.getByRole("button", { name: "Reproduce error" }).click()
    await page.waitForTimeout(300)
    const requests = await devtools.callTool({ name: "list_network_requests", arguments: {} })
    assert.match(JSON.stringify(requests), /failure|503/)
    const consoleOutput = await devtools.callTool({ name: "list_console_messages", arguments: {} })
    assert.match(JSON.stringify(consoleOutput), /controlled-fixture-js-error|fixture-network-status/)
    await Promise.all(clients.splice(0).map((client) => client.close()))
    await browser.close(); browser = undefined
    await manager.stop()
    await manager.start()
    browser = await chromium.connectOverCDP(manager.endpoint!)
    const resumed = browser.contexts()[0]!.pages()[0]!
    await resumed.goto(fixture.origin)
    await resumed.getByText("signed-in", { exact: true }).waitFor()
    assert.equal(await resumed.evaluate(() => localStorage.getItem("fixture-state")), "persistent-test-value")
    // sessionStorage belongs to a tab and is deliberately not required to survive.
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await browser?.close()
    await manager.stop()
    await fixture.close()
  }
})
