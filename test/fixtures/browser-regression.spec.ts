import { test, expect, chromium } from "@playwright/test"
import { existsSync } from "node:fs"
import { browserFixture } from "./browser-site.js"
test("local fixture login sets a persistent cookie and reports controlled failures", async ({ page }) => {
  const fixture = await browserFixture()
  try {
    await page.goto(fixture.origin)
    await expect(page.locator("#auth")).toHaveText("signed-out")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.locator("#auth")).toHaveText("signed-in")
    const cookie = (await page.context().cookies()).find((item) => item.name === "orchestra_fixture_auth")
    expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000)
    const failure = page.waitForResponse((response) => response.url() === `${fixture.origin}/failure`)
    await page.getByRole("button", { name: "Reproduce error" }).click()
    expect((await failure).status()).toBe(503)
  } finally { await fixture.close() }
})
test.skip(!existsSync(process.env.ORCHESTRA_TEST_CHROME ?? chromium.executablePath()), "Chrome/Playwright Chromium has not been explicitly installed")
