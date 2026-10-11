import { access, readFile, realpath, stat } from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"

export interface BrowserInstallation { source: "configured" | "system" | "managed"; executable: string; buildId?: string }
export interface BrowserDiscoveryOptions { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; cacheRoot?: string; systemCandidates?: string[] }

export function browserCacheRoot(options: BrowserDiscoveryOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
  const root = platform === "win32" ? env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    : platform === "darwin" ? path.join(home, "Library", "Application Support")
      : env.XDG_DATA_HOME ?? path.join(home, ".local", "share")
  return options.cacheRoot ?? path.join(root, "opencode-orchestra", "chrome-for-testing")
}

async function executableFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile() && Boolean(await access(file, constants.F_OK).then(() => true)) } catch { return false }
}

export async function discoverBrowser(config: { executable?: string | undefined }, options: BrowserDiscoveryOptions = {}): Promise<BrowserInstallation | undefined> {
  if (config.executable) {
    if (!path.isAbsolute(config.executable) || !await executableFile(config.executable)) throw new Error("browser_executable_invalid: " + config.executable)
    return { source: "configured", executable: config.executable }
  }
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const candidates = options.systemCandidates ?? (platform === "win32"
    ? [path.join(env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"), path.join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"), path.join(env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]
    : platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(env.HOME ?? os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"])
  for (const executable of candidates) if (path.isAbsolute(executable) && await executableFile(executable)) return { source: "system", executable }
  const root = browserCacheRoot(options)
  try {
    const metadata = JSON.parse(await readFile(path.join(root, "current.json"), "utf8")) as Record<string, unknown>
    if (metadata.schemaVersion !== 1 || metadata.complete !== true || typeof metadata.executableRelativePath !== "string" || typeof metadata.buildId !== "string") return undefined
    if (metadata.platform !== platform || metadata.arch !== (options.arch ?? process.arch)) return undefined
    const executable = path.resolve(root, metadata.executableRelativePath)
    const relative = path.relative(path.join(root, "builds"), executable)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
    const resolvedRoot = await realpath(path.join(root, "builds"))
    const resolved = await realpath(executable)
    const actual = path.relative(resolvedRoot, resolved)
    if (actual.startsWith("..") || path.isAbsolute(actual) || !await executableFile(resolved)) return undefined
    return { source: "managed", executable, buildId: metadata.buildId }
  } catch { return undefined }
}
