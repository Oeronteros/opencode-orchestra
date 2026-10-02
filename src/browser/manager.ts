import { spawn, execFile, type ChildProcess } from "node:child_process"
import { access, readFile, stat, readdir, readlink } from "node:fs/promises"
import { constants } from "node:fs"
import { promisify } from "node:util"
import path from "node:path"
import type { BrowserConfig } from "../config/schema.js"
import { ProfileLock, processAlive } from "./profile.js"

const execute = promisify(execFile)
export interface BrowserTarget { id: string; type: string; url: string }
export async function chromeExecutable(configured?: string): Promise<string | undefined> {
  const candidates = configured ? [configured] : process.platform === "win32"
    ? [path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"), path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"), path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try { await access(candidate, constants.X_OK); return candidate } catch { /* Next candidate. */ }
  }
  return undefined
}

/** Verify the listener belongs to our spawned browser, not a reused local endpoint. */
export async function ownsListener(pid: number, port: number): Promise<boolean> {
  if (process.platform === "win32") {
    const { stdout } = await execute("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 5000 })
    return stdout.split(/\r?\n/).some((line) => {
      const parts = line.trim().split(/\s+/)
      return parts[0] === "TCP" && parts[1] === `127.0.0.1:${port}` && parts.at(-1) === String(pid)
    })
  }
  if (process.platform === "linux") {
    const tcp = await readFile("/proc/net/tcp", "utf8")
    const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`
    const inode = tcp.split("\n").map((line) => line.trim().split(/\s+/)).find((row) => row[1] === address && row[3] === "0A")?.[9]
    if (!inode) return false
    const fds = await readdir(`/proc/${pid}/fd`)
    for (const fd of fds) if (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "") === `socket:[${inode}]`) return true
    return false
  }
  const { stdout } = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], { timeout: 5000 })
  return stdout.includes(`p${pid}\n`) && stdout.includes(`n127.0.0.1:${port}`)
}

export class BrowserManager {
  private child: ChildProcess | undefined
  private starting: Promise<string> | undefined
  private endpointValue: string | undefined
  private socketPath: string | undefined
  readonly lock: ProfileLock
  lastFailure: string | undefined
  constructor(readonly profile: string, readonly config: BrowserConfig) { this.lock = new ProfileLock(profile) }
  get running(): boolean { return Boolean(this.child?.pid && this.child.exitCode === null && this.endpointValue) }
  get endpoint(): string | undefined { return this.endpointValue }
  get pid(): number | undefined { return this.child?.pid }

  async start(signal?: AbortSignal): Promise<string> {
    if (this.starting) return this.starting
    if (this.running) { await this.verify(); return this.endpointValue! }
    if (this.child) await this.stop()
    this.starting = this.launch(signal).finally(() => { this.starting = undefined })
    return this.starting
  }
  private async launch(signal?: AbortSignal): Promise<string> {
    const executable = await chromeExecutable(this.config.executable)
    if (!executable) { this.lastFailure = "browser_chrome_missing"; throw new Error(this.lastFailure) }
    signal?.throwIfAborted()
    await this.lock.acquire()
    try {
      const activeFile = path.join(this.profile, "DevToolsActivePort")
      const previous = await readFile(activeFile, "utf8").catch(() => "")
      const launchedAt = Date.now()
      const child = spawn(executable, [
        `--user-data-dir=${this.profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--no-first-run", "--no-default-browser-check", ...(this.config.headless ? ["--headless=new"] : []), "about:blank",
      ], { shell: false, stdio: "ignore", windowsHide: this.config.headless })
      this.child = child
      child.on("error", () => { this.lastFailure = "browser_launch_failed" })
      child.on("exit", () => { this.endpointValue = undefined; this.lastFailure = "browser_exited" })
      if (!child.pid) throw new Error("browser_launch_failed")
      await this.lock.setChrome(child.pid)
      while (Date.now() - launchedAt < this.config.startupTimeoutMs) {
        signal?.throwIfAborted()
        if (child.exitCode !== null || !processAlive(child.pid)) throw new Error("browser_launch_failed")
        const active = await readFile(activeFile, "utf8").catch(() => "")
        const modified = await stat(activeFile).then((s) => s.mtimeMs).catch(() => 0)
        const [rawPort, socketPath] = active.trim().split(/\r?\n/)
        const port = Number(rawPort)
        if ((active !== previous || modified >= launchedAt) && port > 0 && port < 65536 && socketPath?.startsWith("/devtools/browser/")) {
          this.endpointValue = `http://127.0.0.1:${port}`
          this.socketPath = socketPath
          try { await this.verify(); this.lastFailure = undefined; return this.endpointValue } catch { this.endpointValue = undefined }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("browser_start_timeout")
    } catch (error) {
      this.lastFailure = error instanceof Error && error.message.startsWith("browser_") ? error.message : "browser_start_failed"
      await this.stop().catch(() => undefined)
      throw new Error(this.lastFailure)
    }
  }
  async verify(): Promise<void> {
    if (!this.endpointValue || !this.child?.pid || !processAlive(this.child.pid) || !await this.lock.owns()) throw new Error("browser_ownership_lost")
    const url = new URL(this.endpointValue)
    if (!await ownsListener(this.child.pid, Number(url.port))) throw new Error("browser_endpoint_owner_mismatch")
    const value: unknown = await fetch(`${this.endpointValue}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
    if (!value || typeof value !== "object" || !("webSocketDebuggerUrl" in value) || typeof value.webSocketDebuggerUrl !== "string") throw new Error("browser_endpoint_invalid")
    const ws = new URL(value.webSocketDebuggerUrl)
    if (ws.hostname !== "127.0.0.1" || ws.port !== url.port || ws.pathname !== this.socketPath) throw new Error("browser_endpoint_mismatch")
  }
  async targets(): Promise<BrowserTarget[]> {
    await this.verify()
    const value: unknown = await fetch(`${this.endpointValue}/json/list`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
    if (!Array.isArray(value)) throw new Error("browser_targets_invalid")
    return value.filter((t): t is BrowserTarget => t && typeof t === "object" && typeof t.id === "string" && typeof t.type === "string" && typeof t.url === "string")
  }
  async stop(): Promise<void> {
    const child = this.child
    if (!child) { await this.lock.release(); return }
    if (!await this.lock.owns()) throw new Error("browser_ownership_lost")
    if (child.pid && processAlive(child.pid)) {
      if (this.endpointValue && this.socketPath) {
        try {
          await this.verify()
          await new Promise<void>((resolve) => {
            const socket = new WebSocket(this.endpointValue!.replace("http:", "ws:") + this.socketPath)
            const timeout = setTimeout(() => { socket.close(); resolve() }, 3000)
            socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })), { once: true })
            socket.addEventListener("error", () => { clearTimeout(timeout); resolve() }, { once: true })
            socket.addEventListener("close", () => { clearTimeout(timeout); resolve() }, { once: true })
          })
        } catch { /* Fallback only to the owned ChildProcess below. */ }
      }
      // Only this instance's ChildProcess is eligible for termination.
      if (processAlive(child.pid)) child.kill("SIGTERM")
      const until = Date.now() + 5000
      while (processAlive(child.pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
      if (processAlive(child.pid)) {
        if (process.platform === "win32") await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 })
        else child.kill("SIGKILL")
        const killedUntil = Date.now() + 3000
        while (processAlive(child.pid) && Date.now() < killedUntil) await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    this.child = undefined
    this.endpointValue = undefined
    await this.lock.release()
  }
}
