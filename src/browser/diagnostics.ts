import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BrowserConfig } from "../config/schema.js"
import { backendEntry, browserNode } from "./packages.js"
import { chromeExecutable } from "./manager.js"
import { profileDirectory, profileLocked } from "./profile.js"
import type { BrowserStatus } from "./runtime.js"

export async function persistBrowserStatus(file: string, status: BrowserStatus): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ updatedAt: Date.now(), status }), { mode: 0o600 })
}
export async function refreshBrowserStatus(base: BrowserStatus, file: string): Promise<BrowserStatus> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { updatedAt?: number; status?: BrowserStatus }
    if (typeof value.updatedAt !== "number" || Date.now() - value.updatedAt > 30000 || !value.status) return base
    const status = value.status
    // Closed whitelist: never relay unexpected snapshot metadata, URLs or backend errors.
    return { ...base, connected: { playwright: status.connected?.playwright === true, devtools: status.connected?.devtools === true }, browserRunning: status.browserRunning === true, profileBusy: status.profileBusy === true, activeScenario: status.activeScenario === true, runtimeAvailable: status.runtimeAvailable === true,
      ...(typeof status.lastFailure === "string" && /^browser_[a-z0-9_.]+$/.test(status.lastFailure) ? { lastFailure: status.lastFailure } : {}),
    }
  } catch { return base }
}
/** Local files and executable probes only; never launch Chrome, connect CDP, or fetch packages. */
export async function browserDiagnostics(directory: string, config: BrowserConfig, snapshotFile?: string): Promise<BrowserStatus & { chromeAvailable: boolean; nodeAvailable: boolean }> {
  const profile = await profileDirectory(directory, config.profile, config.sharedProfiles.includes(config.profile))
  const base: BrowserStatus = { configured: config.mode !== "off", mode: config.mode, profile: config.profile,
    installed: { playwright: Boolean(backendEntry("playwright")), devtools: Boolean(backendEntry("devtools")) },
    connected: { playwright: false, devtools: false }, browserRunning: false, profileBusy: await profileLocked(profile), activeScenario: false, runtimeAvailable: false,
  }
  return { ...(snapshotFile ? await refreshBrowserStatus(base, snapshotFile) : base), chromeAvailable: Boolean(await chromeExecutable(config.executable)), nodeAvailable: Boolean(browserNode(config)) }
}
