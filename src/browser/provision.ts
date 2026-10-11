import { spawn } from "node:child_process"
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { browserCacheRoot, discoverBrowser, type BrowserDiscoveryOptions, type BrowserInstallation } from "./discovery.js"
import { browserNode } from "./packages.js"
import type { BrowserConfig } from "../config/schema.js"
import { processAlive } from "./profile.js"

export const BROWSER_DOWNLOAD_TIMEOUT_MS = 600_000
export interface BrowserProvisionOptions extends BrowserDiscoveryOptions { signal?: AbortSignal; timeoutMs?: number; workerEntry?: string }
type ProvisionConfig = Pick<BrowserConfig, "executable" | "nodeExecutable" | "mode"> & { download: boolean }

async function delay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, 100)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export async function ensureBrowser(config: ProvisionConfig, options: BrowserProvisionOptions = {}): Promise<BrowserInstallation> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? BROWSER_DOWNLOAD_TIMEOUT_MS)])
  signal.throwIfAborted()
  if (config.mode === "off") throw new Error("browser_disabled")
  const existing = await discoverBrowser(config.executable ? { executable: config.executable } : {}, options)
  if (existing) return existing
  if (!config.download) throw new Error("browser_chrome_missing: downloads disabled")
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = platform === "win32" && arch === "x64" ? "win64" : platform === "darwin" && arch === "x64" ? "mac" : platform === "darwin" && arch === "arm64" ? "mac_arm" : platform === "linux" && arch === "x64" ? "linux" : undefined
  if (!target) throw new Error(`browser_platform_unsupported: ${platform}/${arch}`)
  const node = browserNode({ ...(config.nodeExecutable ? { nodeExecutable: config.nodeExecutable } : {}), mode: config.mode, profile: "default", profiles: ["default"], sharedProfiles: [], download: config.download, headless: false, startupTimeoutMs: 20_000, operationTimeoutMs: 60_000, maxOutputChars: 16_000, artifactRetentionHours: 24 } as BrowserConfig)
  if (!node) throw new Error("browser_node_unavailable: Node >=22.12 required")
  const root = browserCacheRoot(options)
  await mkdir(root, { recursive: true })
  const lock = path.join(root, ".install-lock")
  const token = randomUUID()
  while (true) {
    signal.throwIfAborted()
    try { await mkdir(lock); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = await readFile(path.join(lock, "owner.json"), "utf8").then((v) => JSON.parse(v) as { pid: number }).catch(() => undefined)
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && !processAlive(owner.pid)) {
        // Atomically claim a dead lock before removing it; never remove a new owner's lock.
        const abandoned = path.join(root, `.dead-lock-${randomUUID()}`)
        await rename(lock, abandoned).then(() => rm(abandoned, { recursive: true, force: true })).catch(() => undefined)
      } else await delay(signal)
    }
  }
  const staging = path.join(root, `.staging-${token}`)
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }))
    const cached = await discoverBrowser(config.executable ? { executable: config.executable } : {}, options)
    if (cached) return cached
    await mkdir(staging)
    const result = await new Promise<{ buildId: string; executable: string }>((resolve, reject) => {
      const child = spawn(node, [options.workerEntry ?? fileURLToPath(new URL("./download-worker.js", import.meta.url)), staging, target], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = "", stderr = ""
      const abort = () => { child.kill() }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16384) })
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
      child.on("error", reject)
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort)
        if (signal.aborted) { reject(signal.reason); return }
        if (code !== 0) { reject(new Error(`browser_download_failed: ${stderr}`)); return }
        try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)) } catch { reject(new Error("browser_download_result_invalid")) }
      })
    })
    if (!result || typeof result.buildId !== "string" || !/^\d+(\.\d+){3}$/.test(result.buildId) || typeof result.executable !== "string") throw new Error("browser_download_result_invalid")
    const relative = path.relative(await realpath(staging), await realpath(result.executable))
    if (relative.startsWith("..") || path.isAbsolute(relative) || !(await stat(result.executable)).isFile()) throw new Error("browser_download_executable_invalid")
    signal.throwIfAborted()
    await mkdir(path.join(root, "builds"), { recursive: true })
    const destination = path.join(root, "builds", token)
    await rename(staging, destination)
    const metadata = path.join(root, `.current-${token}.json`)
    await writeFile(metadata, JSON.stringify({ schemaVersion: 1, platform, arch, buildId: result.buildId, complete: true, executableRelativePath: path.join("builds", token, relative) }))
    await rename(metadata, path.join(root, "current.json"))
    return { source: "managed", executable: path.join(destination, relative), buildId: result.buildId }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    const owner = await readFile(path.join(lock, "owner.json"), "utf8").then((v) => JSON.parse(v) as { token: string }).catch(() => undefined)
    if (owner?.token === token) await rm(lock, { recursive: true, force: true })
  }
}
