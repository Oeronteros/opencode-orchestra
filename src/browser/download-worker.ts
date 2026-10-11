import { Browser, BrowserPlatform, BrowserTag, install, resolveBuildId } from "@puppeteer/browsers"

const [cacheDir, platform] = process.argv.slice(2)
if (!cacheDir || !Object.values(BrowserPlatform).includes(platform as BrowserPlatform)) throw new Error("browser_download_arguments_invalid")
try {
  const buildId = await resolveBuildId(Browser.CHROME, platform as BrowserPlatform, BrowserTag.STABLE)
  const browser = await install({ browser: Browser.CHROME, platform: platform as BrowserPlatform, buildId, cacheDir })
  console.log(JSON.stringify({ buildId, executable: browser.executablePath }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
