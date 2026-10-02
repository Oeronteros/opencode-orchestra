import { mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { loadConfig } from "../config/load.js"
import { browserProfileNameSchema } from "../config/schema.js"
import { BrowserManager, chromeExecutable } from "./manager.js"
import { backendEntry, browserNode } from "./packages.js"
import { orchestraDataDirectory, profileDirectory, profileLocked } from "./profile.js"

export interface BrowserCommandOptions {
  action: "status" | "login" | "restart" | "profiles" | "select" | "reset"
  directory: string
  profile?: string
  confirm?: string
}
export function parseBrowserArguments(args: string[]): BrowserCommandOptions {
  const action = args[0] ?? "status"
  if (!["status", "login", "restart", "profiles", "select", "reset"].includes(action)) throw new Error("Unknown browser action")
  const result: BrowserCommandOptions = { action: action as BrowserCommandOptions["action"], directory: process.cwd() }
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]
    const value = args[++i]
    if (!value) throw new Error(`${flag} requires a value`)
    if (flag === "--directory") result.directory = path.resolve(value)
    else if (flag === "--profile") result.profile = browserProfileNameSchema.parse(value)
    else if (flag === "--confirm") result.confirm = value
    else throw new Error(`Unknown browser option ${flag}`)
  }
  return result
}
export async function runBrowserCommand(options: BrowserCommandOptions): Promise<void> {
  const config = (await loadConfig(options.directory)).config.browser
  const name = options.profile ?? config.profile
  if (!config.profiles.includes(name)) throw new Error("Profile is not configured; add it to browser.profiles first")
  const profile = await profileDirectory(options.directory, name, config.sharedProfiles.includes(name))
  if (options.action === "profiles") { console.log(JSON.stringify({ selected: config.profile, profiles: config.profiles, sharedProfiles: config.sharedProfiles })); return }
  if (options.action === "status") {
    console.log(JSON.stringify({ configured: config.mode !== "off", mode: config.mode, profile: name, profileDirectory: profile,
      installed: { playwright: Boolean(backendEntry("playwright")), devtools: Boolean(backendEntry("devtools")) }, nodeAvailable: Boolean(browserNode(config)), chromeAvailable: Boolean(await chromeExecutable(config.executable)), profileBusy: await profileLocked(profile), connected: "query orchestra_browser status in OpenCode", browserRunning: "query orchestra_browser status in OpenCode" }, null, 2))
    return
  }
  if (options.action === "select") {
    const file = path.join(options.directory, ".opencode", "orchestra.jsonc")
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}\n"; throw error })
    const errors: ParseError[] = []
    parse(text, errors, { allowTrailingComma: true })
    if (errors.length) throw new Error("Invalid project configuration")
    await mkdir(path.dirname(file), { recursive: true })
    let updated = applyEdits(text, modify(text, ["browser", "profiles"], config.profiles, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    updated = applyEdits(updated, modify(updated, ["browser", "profile"], name, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    await writeFile(file, updated)
    console.log(`Selected ${name}; restart OpenCode to apply it. Profile data is retained.`)
    return
  }
  if (options.action === "reset") {
    if (options.confirm !== name) throw new Error(`Profile reset requires --confirm ${name}`)
    const root = path.resolve(orchestraDataDirectory(), "browser", "profiles")
    const relative = path.relative(root, path.resolve(profile))
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Profile escapes the Orchestra data directory")
    if (await lstat(path.join(profile, ".orchestra-lock")).then(() => true).catch(() => false)) throw new Error("Profile has a lock; close its owning process first. Orphan locks are never removed automatically.")
    if (await lstat(profile).then((s) => s.isSymbolicLink()).catch(() => false)) throw new Error("Refusing to reset a symlink profile")
    await rm(profile, { recursive: true, force: true })
    console.log(`Reset ${name}; site authentication and persistent data were removed.`)
    return
  }
  if (config.mode === "off") throw new Error("Configure browser.mode explicitly first")
  const manager = new BrowserManager(profile, { ...config, headless: false })
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    await manager.start(controller.signal)
    console.log(`Profile ${name} is open. Sign in in Chrome; never send passwords or 2FA codes to chat. Close Chrome or press Ctrl+C when finished.`)
    while (manager.running && !controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 250))
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    await manager.stop()
  }
}
