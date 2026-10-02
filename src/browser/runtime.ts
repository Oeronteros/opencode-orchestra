import { mkdir, readdir, stat, rm, writeFile, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { ToolContext, Result } from "@opencode/plugin/promise/tool"
import type { BrowserConfig } from "../config/schema.js"
import type { OrchestrationRunState } from "../orchestration/run-state.js"
import { BrowserManager } from "./manager.js"
import { profileDirectory, orchestraDataDirectory, profileLocked, processAlive } from "./profile.js"
import { backendEntry, browserNode } from "./packages.js"
import { assertBrowserGrant, chooseBackend, operationForTool, type BrowserBackend, type BrowserTask } from "./policy.js"

export interface BrowserStatus {
  configured: boolean
  mode: BrowserConfig["mode"]
  profile: string
  installed: Record<BrowserBackend, boolean>
  connected: Record<BrowserBackend, boolean>
  browserRunning: boolean
  profileBusy: boolean
  activeScenario: boolean
  lastFailure?: string
  runtimeAvailable: boolean
}
export interface BrowserCallRecord {
  backend: BrowserBackend; agent: string; rootSessionID: string; nodeID: string; tool: string
  durationMs: number; success: boolean; outputChars: number
}
export interface BrowserHost {
  bind(runtime: BrowserRuntime): void
  available(): Record<BrowserBackend, boolean>
  connected(): Promise<Record<BrowserBackend, boolean>>
  connect(backend: BrowserBackend, manager: BrowserManager, artifacts: string, signal?: AbortSignal): Promise<void>
  disconnect(): Promise<void>
  call(backend: BrowserBackend, name: string, input: unknown, context: ToolContext): Promise<Result>
}
interface Scenario {
  sessionID: string; agent: string; rootSessionID: string; nodeID: string; profile: string
  targetID: string; backend: BrowserBackend; grant: BrowserTask; freshSnapshot: boolean; uncertain: boolean
  activeCalls: number
  releasePending?: boolean
}
function resultText(result: Result): string {
  return typeof result.content === "string" ? result.content : result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? ""
}
function allowedUrl(url: string, origins: string[]): boolean {
  if (url === "about:blank") return true
  try { const value = new URL(url); return !value.username && !value.password && origins.includes(value.origin) } catch { return false }
}

/** A single scenario lease spans reproduction -> evidence -> verification. */
export class BrowserRuntime {
  private scenario: Scenario | undefined
  private manager: BrowserManager | undefined
  private selectedProfile: string
  private changing = false
  private disposed = false
  private readonly shutdown = new AbortController()
  private failure: string | undefined
  private artifactDirectory: string | undefined
  constructor(
    readonly config: BrowserConfig,
    readonly directory: string,
    readonly coordinator: OrchestrationRunState,
    readonly host?: BrowserHost,
    private readonly record?: (call: BrowserCallRecord) => Promise<void>,
    readonly dataRoot = orchestraDataDirectory(),
    private readonly managerFactory: (profile: string, config: BrowserConfig) => BrowserManager = (profile, config) => new BrowserManager(profile, config),
  ) { this.selectedProfile = config.profile; host?.bind(this) }

  async status(): Promise<BrowserStatus> {
    const profile = await profileDirectory(this.directory, this.selectedProfile, this.config.sharedProfiles.includes(this.selectedProfile), this.dataRoot)
    const locked = await profileLocked(profile)
    return {
      configured: this.config.mode !== "off", mode: this.config.mode, profile: this.selectedProfile,
      installed: { playwright: Boolean(backendEntry("playwright")), devtools: Boolean(backendEntry("devtools")) },
      connected: await this.host?.connected().catch(() => ({ playwright: false, devtools: false })) ?? { playwright: false, devtools: false },
      browserRunning: this.manager?.running ?? false, profileBusy: Boolean(locked && !await this.manager?.lock.owns()),
      activeScenario: Boolean(this.scenario), runtimeAvailable: Boolean(this.host && browserNode(this.config)),
      ...(this.failure ? { lastFailure: this.failure } : this.manager?.lastFailure ? { lastFailure: this.manager.lastFailure } : {}),
    }
  }
  private caller(context: ToolContext, profile: string): { grant: BrowserTask; rootSessionID: string; nodeID: string } {
    const link = this.coordinator.sessionContext(context.sessionID)
    if (link) {
      if (link.agent !== context.agent) throw new Error("browser_runtime_agent_mismatch")
      const node = this.coordinator.sealedNode(context.sessionID, link.nodeId)
      if (!node || node.status !== "running") throw new Error("browser_inactive_contract")
      return { grant: assertBrowserGrant(context.agent, node.contract, profile), rootSessionID: link.rootSessionID, nodeID: link.nodeId }
    }
    // Lead verifies a completed browser node; it cannot invent a self-granted scenario.
    if (context.agent !== "orch-lead") throw new Error("browser_unmanaged_session")
    const snapshot = this.coordinator.snapshot(context.sessionID)
    const completed = snapshot?.nodes.map((node) => this.coordinator.sealedNode(context.sessionID, node.id)).find((node) => node?.status === "succeeded" && node.contract.browser?.profile === profile)
    if (!completed) throw new Error("browser_lead_requires_completed_node")
    const grant = assertBrowserGrant(context.agent, completed.contract, profile)
    return { grant: { ...grant, operations: grant.operations.filter((op) => op === "observe" || op === "navigate") }, rootSessionID: this.coordinator.rootSessionID(context.sessionID), nodeID: completed.id }
  }
  async prepare(context: ToolContext, profile = this.config.profile, task?: BrowserTask["task"], reason?: string): Promise<BrowserStatus> {
    context = { ...context, signal: AbortSignal.any([context.signal, this.shutdown.signal]) }
    if (this.disposed || !this.host) throw new Error("browser_requires_opencode_v2_2.0.16")
    if (!this.config.profiles.includes(profile)) throw new Error("browser_profile_denied")
    const caller = this.caller(context, profile)
    if (!caller.grant.operations.includes("observe")) throw new Error("browser_prepare_requires_observe_grant")
    const requestedTask = task ?? caller.grant.task
    if (requestedTask !== caller.grant.task && !reason?.trim()) throw new Error("browser_handoff_reason_required")
    const backend = chooseBackend(this.config, requestedTask, this.host.available(), this.scenario?.backend)
    if (!backend) throw new Error("browser_use_web_tools_or_playwright_test")
    if (this.changing || this.scenario && this.scenario.sessionID !== context.sessionID) throw new Error("browser_scenario_busy")
    if (this.scenario?.activeCalls) throw new Error("browser_operation_busy")
    if (this.scenario && this.scenario.backend !== backend && !reason?.trim()) throw new Error("browser_handoff_reason_required")
    if (this.scenario && this.scenario.profile !== profile) throw new Error("browser_release_before_profile_switch")
    this.changing = true
    try {
      context.signal.throwIfAborted()
      if (this.manager && this.selectedProfile !== profile) { await this.host.disconnect(); await this.manager.stop(); this.manager = undefined }
      this.selectedProfile = profile
      const location = await profileDirectory(this.directory, profile, this.config.sharedProfiles.includes(profile), this.dataRoot)
      this.manager ??= this.managerFactory(location, this.config)
      await this.manager.start(context.signal)
      const pages = (await this.manager.targets()).filter((target) => target.type === "page")
      if (pages.length !== 1) throw new Error("browser_requires_one_tab_close_extra_tabs")
      const page = pages[0]!
      if (this.scenario && page.id !== this.scenario.targetID) throw new Error("browser_target_changed")
      if (!allowedUrl(page.url, caller.grant.origins)) throw new Error("browser_current_origin_denied")
      this.scenario = { ...caller, sessionID: context.sessionID, agent: context.agent, profile, targetID: page.id, backend, freshSnapshot: false, uncertain: this.scenario?.uncertain ?? false, activeCalls: 0 }
      this.artifactDirectory ??= path.join(this.dataRoot, "browser", "artifacts", randomUUID())
      await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 })
      await writeFile(path.join(this.artifactDirectory, ".owner.json"), JSON.stringify({ pid: process.pid, closed: false }), { mode: 0o600 })
      await this.expireArtifacts()
      await this.host.connect(backend, this.manager, this.artifactDirectory, context.signal)
      // Both catalogs identify the only real tab independently. IDs never cross adapters.
      if (backend === "playwright") await this.preparationCall(backend, "browser_tabs", { action: "select", index: 0 }, context)
      else {
        const pagesResult = await this.preparationCall(backend, "list_pages", {}, context)
        const ids = [...resultText(pagesResult).matchAll(/^\s*(\d+):\s/gm)].map((m) => Number(m[1]))
        if (ids.length !== 1) throw new Error("browser_backend_tab_mapping_unavailable")
        await this.preparationCall(backend, "select_page", { pageId: ids[0] }, context)
      }
      await this.preparationCall(backend, backend === "playwright" ? "browser_snapshot" : "take_snapshot", {}, context)
      // Model must request its own fresh snapshot before using refs from this backend.
      this.scenario.freshSnapshot = false
      this.failure = undefined
      return this.status()
    } catch (error) {
      this.failure = error instanceof Error && error.message.startsWith("browser_") ? error.message : "browser_prepare_failed"
      this.scenario = undefined
      throw new Error(this.failure)
    } finally { this.changing = false }
  }
  async execute(backend: BrowserBackend, name: string, input: unknown, context: ToolContext, execute: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    if (this.changing || this.disposed) throw new Error("browser_scenario_preparing_or_disposed")
    const scenario = this.scenario
    const operation = operationForTool(name)
    if (!scenario || scenario.sessionID !== context.sessionID || scenario.agent !== context.agent || scenario.backend !== backend) throw new Error("browser_lease_required")
    if (!operation || !this.manager) throw new Error("browser_tool_denied")
    const current = this.caller(context, scenario.profile)
    const trustedContract = { objective: "", inputs: [], deliverable: "", acceptanceCriteria: [], allowedPaths: [], exclusiveResources: [`browser:${scenario.profile}`], delegation: { allowed: false, maxChildren: 0 }, browser: current.grant }
    assertBrowserGrant(context.agent, trustedContract, scenario.profile, operation)
    if (scenario.activeCalls) throw new Error("browser_operation_busy")
    context.signal.throwIfAborted()
    scenario.activeCalls++
    const started = Date.now()
    let success = false
    let outputChars = 0
    let executing = false
    try {
      const pages = (await this.manager.targets()).filter((t) => t.type === "page")
      if (pages.length !== 1 || pages[0]?.id !== scenario.targetID) throw new Error("browser_target_changed")
      if (!allowedUrl(pages[0].url, scenario.grant.origins)) throw new Error("browser_current_origin_denied")
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {}
      if (args.initScript !== undefined) {
        assertBrowserGrant(context.agent, trustedContract, scenario.profile, "evaluate")
        if (!scenario.freshSnapshot || scenario.uncertain) throw new Error("browser_fresh_snapshot_required_inspect_before_mutation")
      }
      if (name === "performance_start_trace" && args.reload !== false && !current.grant.operations.includes("navigate")) throw new Error("browser_trace_reload_requires_navigation_grant")
      if (typeof args.url === "string" && !allowedUrl(args.url, scenario.grant.origins)) throw new Error("browser_navigation_origin_denied")
      if (args.pageId !== undefined || args.tabIndex !== undefined) throw new Error("browser_foreign_tab_identifier_denied")
      if ((operation === "interact" || operation === "evaluate") && (!scenario.freshSnapshot || scenario.uncertain)) throw new Error("browser_fresh_snapshot_required_inspect_before_mutation")
      for (const key of ["filename", "filePath", "outputPath", "requestFilePath", "responseFilePath"]) if (typeof args[key] === "string") {
        if (!this.artifactDirectory) throw new Error("browser_artifact_directory_unavailable")
        const file = path.resolve(this.artifactDirectory, args[key])
        const relative = path.relative(this.artifactDirectory, file)
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("browser_artifact_path_denied")
        args[key] = file
      }
      if (["browser_file_upload", "upload_file"].includes(name)) throw new Error("browser_upload_requires_external_file_permission")
      executing = true
      // The executor receives the runtime signal. A timeout also fences the lease; no automatic retry.
      const result = await execute(AbortSignal.any([context.signal, this.shutdown.signal, AbortSignal.timeout(this.config.operationTimeoutMs)]))
      context.signal.throwIfAborted()
      if (Date.now() - started > this.config.operationTimeoutMs) throw new Error("browser_operation_timeout_inspect_state")
      const after = (await this.manager.targets()).filter((t) => t.type === "page")
      if (after.length !== 1 || after[0]?.id !== scenario.targetID || !allowedUrl(after[0].url, scenario.grant.origins)) throw new Error("browser_post_action_target_or_origin_changed")
      const content = resultText(result)
      outputChars = content.length
      if (/^### Error\b/m.test(content) || result.metadata?.isError === true) throw new Error("browser_backend_action_failed_inspect_state")
      if (name === "browser_snapshot" || name === "take_snapshot") { scenario.freshSnapshot = true; scenario.uncertain = false }
      if (operation !== "observe") scenario.freshSnapshot = false
      success = true
      if (content.length <= this.config.maxOutputChars) return result
      const file = path.join(this.artifactDirectory!, `${randomUUID()}.txt`)
      await writeFile(file, content, { mode: 0o600 })
      return { content: content.slice(0, this.config.maxOutputChars) + `\n[truncated: ${content.length} characters; private artifact ${file}; retention ${this.config.artifactRetentionHours}h, cleanup on a later prepare]`, metadata: { truncated: true, outputChars } }
    } catch (error) {
      if (executing && operation !== "observe") scenario.uncertain = true
      this.failure = error instanceof Error && error.message.startsWith("browser_") ? error.message : "browser_operation_failed_inspect_state"
      throw new Error(this.failure)
    } finally {
      scenario.activeCalls--
      if (scenario.releasePending && this.scenario === scenario) this.scenario = undefined
      await this.record?.({ backend, agent: context.agent, rootSessionID: scenario.rootSessionID, nodeID: scenario.nodeID, tool: name, durationMs: Date.now() - started, success, outputChars }).catch(() => undefined)
    }
  }
  releaseSession(sessionID: string): void {
    if (this.scenario?.sessionID !== sessionID) return
    if (this.scenario.activeCalls) { this.scenario.uncertain = true; this.scenario.releasePending = true; return }
    this.scenario = undefined
  }
  async release(context: ToolContext): Promise<void> {
    if (this.scenario && this.scenario.sessionID !== context.sessionID) throw new Error("browser_scenario_busy")
    if (this.scenario?.activeCalls) throw new Error("browser_operation_busy")
    this.releaseSession(context.sessionID)
  }
  async restart(context: ToolContext): Promise<void> {
    if (this.scenario || this.changing) throw new Error("browser_release_before_restart")
    this.caller(context, this.selectedProfile)
    await this.host?.disconnect()
    await this.manager?.stop()
    this.manager = undefined
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.shutdown.abort()
    // Native MCP executions must stop before the owned browser is terminated.
    await this.host?.disconnect()
    while (this.changing) await new Promise((resolve) => setTimeout(resolve, 10))
    await this.manager?.stop()
    this.scenario = undefined
    if (this.artifactDirectory) await writeFile(path.join(this.artifactDirectory, ".owner.json"), JSON.stringify({ pid: process.pid, closed: true }), { mode: 0o600 })
  }
  private async preparationCall(backend: BrowserBackend, name: string, input: unknown, context: ToolContext): Promise<Result> {
    const scenario = this.scenario
    if (!scenario || !this.host || !this.manager) throw new Error("browser_lease_required")
    context.signal.throwIfAborted()
    await this.manager.verify()
    const started = Date.now()
    let success = false
    let outputChars = 0
    try {
      const result = await this.host.call(backend, name, input, context)
      const text = resultText(result)
      outputChars = text.length
      if (/^### Error\b/m.test(text) || result.metadata?.isError === true) throw new Error("browser_prepare_observation_failed")
      context.signal.throwIfAborted()
      success = true
      return result
    } finally {
      await this.record?.({ backend, agent: context.agent, rootSessionID: scenario.rootSessionID, nodeID: scenario.nodeID, tool: name, durationMs: Date.now() - started, success, outputChars }).catch(() => undefined)
    }
  }
  private async expireArtifacts(): Promise<void> {
    const root = path.join(this.dataRoot, "browser", "artifacts")
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
      const directory = path.join(root, entry.name)
      if (directory === this.artifactDirectory) continue
      const owner: unknown = await readFile(path.join(directory, ".owner.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined)
      if (!owner || typeof owner !== "object" || !("pid" in owner) || typeof owner.pid !== "number" || !("closed" in owner) || typeof owner.closed !== "boolean") continue
      if (!owner.closed && processAlive(owner.pid)) continue
      const info = await stat(directory).catch(() => undefined)
      if (!info) continue
      if (Date.now() - info.mtimeMs > this.config.artifactRetentionHours * 3600000) await rm(directory, { recursive: true, force: true })
    }
  }
}
