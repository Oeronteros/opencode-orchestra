# Out-of-box Browser MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Playwright MCP and Chrome DevTools MCP usable after installation, automatically provisioning Chrome for Testing when system Chrome is absent.

**Architecture:** Separate offline discovery from bounded, cancellable provisioning. Reuse the existing browser manager, profile ownership and native OpenCode MCP transport; enable both backends against one CDP endpoint on authorized preparation. Fix configuration migration and native registration paths rather than introducing independent browser processes.

**Tech Stack:** TypeScript, Node >=22.12, Bun-hosted plugin support, OpenCode V2 >=2.0.16, Zod 4, jsonc-parser, direct `@puppeteer/browsers` dependency, node:test.

**Spec:** `docs/superpowers/specs/2026-10-11-browser-out-of-box-design.md` (approved by user).

## Global Constraints

- System Chrome first; explicit `browser.executable` has higher priority and invalid overrides are errors.
- Missing browser mode means `auto`; explicit `off` survives default reinstallation.
- `browser.download` defaults to true. No browser download during plugin import, status, doctor or dry-run.
- Download deadline is 10 minutes; cancellation stops actual work, not merely the awaiting Promise.
- CfT support initially covers Windows x64, macOS x64/arm64, Linux x64; never map Linux ARM64 to x64.
- Keep pinned `@playwright/mcp` 0.0.83 and `chrome-devtools-mcp` 1.10.1 unless a reproduced compatibility failure requires a separately documented change.
- Persistent profiles are separate from binary cache. Both backends share one managed Chrome.
- Core installation survives browser provisioning failure, reporting a warning; readiness requires live evidence.
- `--no-deps` skips install-time downloads, while runtime provisioning follows `browser.download`.
- Preserve user MCP commands and direct tool execution, JSONC comments and unrelated settings.
- No package publication or restart of the user's running OpenCode service in this plan.

## Review Focus

- Unicode/spaces in cache and executable paths: use argv, never interpolate shell commands (Task 2).
- Cache metadata points outside its root or a symlink escapes it: reject rather than execute (Task 1).
- Installer interrupted while holding its cache lock: recover only a demonstrably dead owner; never steal a live/unknown lock (Task 2).
- MCP reload replays transforms: owned servers must not become user conflicts or receive recursively wrapped executors (Task 5).
- Existing global auto plus project off, or partial browser object: preserve effective precedence and missing-field defaults (Task 3).

## File and dependency map

- New `src/browser/discovery.ts`: system/configured/cache discovery and platform paths, no network.
- New `src/browser/provision.ts`: transaction, lock, worker lifecycle and publication.
- New `src/browser/download-worker.ts`: official CfT resolution/install through public Puppeteer browsers APIs.
- New `src/browser/install-config.ts`: pure JSONC browser migration shared by installer tests.
- Existing `src/browser/manager.ts`: use ensureBrowser before acquiring the profile lock.
- Existing `src/browser/runtime.ts`, `v2.ts`, `policy.ts`: dual-backend preparation, backend errors, user-server isolation.
- Existing `src/v2.ts`: native schema compatibility for routing tools.
- Existing config/schema, CLI, browser CLI/diagnostics, plugin status and dashboard types/view: surface actual state consistently.
- Tests extend `test/browser.test.ts`, `browser-v2.test.ts`, `browser-live.test.ts`, `v2.test.ts`, `cli.test.ts`, `config.test.ts`, `doctor.test.ts`, `plugin-status.test.ts`; add focused discovery/provisioning tests and fixture worker.
- `package.json`/lock: direct installer dependency, include new tests in explicit npm test list; ensure worker emitted by plugin build and included in packed dist.

## Task 1: Offline discovery and cache contract

**Files:** Create `src/browser/discovery.ts`, `test/browser-discovery.test.ts`. Modify `src/browser/manager.ts`, `package.json`.

**Interfaces:** Export `BrowserInstallation = { source: "configured" | "system" | "managed"; executable: string; buildId?: string }`; `BrowserDiscoveryOptions = { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; cacheRoot?: string; systemCandidates?: string[] }`; `browserCacheRoot(options?: BrowserDiscoveryOptions): string`; `discoverBrowser(config: Pick<BrowserConfig, "executable">, options?: BrowserDiscoveryOptions): Promise<BrowserInstallation | undefined>`. Metadata: `{ schemaVersion: 1, platform: string, arch: string, buildId: string, executableRelativePath: string, complete: true }`, under `<cacheRoot>/current.json`, pointing to a completed directory within `<cacheRoot>/builds/`.

- [ ] Write discovery tests: explicit executable wins over system/cache; missing override rejects with `browser_executable_invalid`; system wins over valid cache; no browser returns undefined. Assert no child/network invocation on discovery.
- [ ] Add path tests: Windows LOCALAPPDATA, macOS user Library, Linux XDG_DATA_HOME/fallback; metadata traversal, absolute paths, malformed JSON, missing binary and escaping symlinks are never returned as managed installations.
- [ ] Compile with `npx tsc -p tsconfig.test.json`; run `node --test dist-test/test/browser-discovery.test.js`. Confirm missing implementation fails first.
- [ ] Implement interfaces; retain `chromeExecutable(configured?: string): Promise<string | undefined>` as an offline compatibility wrapper while existing callers migrate. Include standard per-user macOS installation and PATH discovery without launching binaries.
- [ ] Repeat focused tests; expected all pass. Commit `feat: discover system and managed Chrome installations` with only task files.

## Task 2: Cancellable official CfT provisioning

**Files:** Create `src/browser/provision.ts`, `src/browser/download-worker.ts`, `test/browser-provision.test.ts`, `test/fixtures/browser-download-worker.mjs`. Modify `package.json`, `package-lock.json`.

**Interfaces:** Export `BrowserProvisionOptions extends BrowserDiscoveryOptions { signal?: AbortSignal; onProgress?: (event: { phase: "resolving" | "downloading" | "extracting" | "ready"; downloadedBytes?: number; totalBytes?: number }) => void; timeoutMs?: number; workerEntry?: string }`; `ensureBrowser(config: Pick<BrowserConfig, "executable" | "download" | "mode" | "nodeExecutable">, options?: BrowserProvisionOptions): Promise<BrowserInstallation>`. `workerEntry` is an internal test seam, never user configuration. Export `BROWSER_DOWNLOAD_TIMEOUT_MS = 600_000`. Errors carry `code`, useful `message`, and original `cause`.

- [ ] Resolve a current Node-22-compatible release of `@puppeteer/browsers`, inspect public types/engine constraints, record and pin that exact version as a direct dependency. Context7 confirms `install({browser, buildId, platform, cacheDir})`; verify `resolveBuildId` and platform enum in the selected package before using them. Do not guess a signal option.
- [ ] Write fixture-backed tests: no worker for system/cache/off/download=false; unavailable real Node fails before download; fake worker emits successful staged layout which is atomically published; subsequent ensure call is offline. Unsupported Linux ARM64 fails without worker launch.
- [ ] Add tests for truncated/invalid worker output, simulated HTTP/ENOSPC/extraction failures, abort and deadline termination, Unicode/spaces, concurrent callers, dead-owner lock recovery, live-owner wait cancellation, and no metadata pointing at partial data. Assert timeout default exactly `600_000` and previous completed cache survives each failure.
- [ ] Run compile and `node --test dist-test/test/browser-provision.test.js`, observing initial failures.
- [ ] Implement Node child worker with JSON-line progress/results; isolate official manifest resolution and `install` in that process so timeout/abort can terminate and await it. Install into a unique sibling staging directory. Do not enable OS dependency installation or custom mirrors. Validate platform mapping explicitly before resolving the build.
- [ ] Implement per-root exclusive lock with owner PID/token, bounded abortable waiting, ownership-checked release, and recovery only for a confirmed dead PID. Re-run discovery after lock acquisition. Validate completed executable layout, rename staging into builds, atomically replace metadata, then return discovery result. Wait for child termination before deleting staging/releasing lock.
- [ ] Run focused tests; all pass. Commit `feat: provision Chrome for Testing with bounded downloads`.

## Task 3: Default configuration and install-time preparation

**Files:** Create `src/browser/install-config.ts`. Modify `src/config/schema.ts`, `schema/opencode-orchestra.schema.json`, `src/cli.ts`, `test/config.test.ts`, `test/cli.test.ts`, `test/browser-v2.test.ts`, `test/browser.test.ts`.

**Interfaces:** `migrateBrowserConfig(text: string, choice: { browserMode?: BrowserConfig["mode"]; playwright?: boolean }): { text: string; changed: boolean; browser: BrowserConfig }`. Preserve input JSONC via targeted edits; return validated browser config. Extend existing `InstallResult.dependencies` with `browser` containing provisioning status, optional installation and error detail; keep existing companion fields.

- [ ] Write assertions: `browserConfigSchema.parse({}).mode === "auto"`, `.download === true`, explicit off remains off, profiles remain string arrays. Partial object `{headless:true}` receives defaults without erasing headless.
- [ ] Write migration tests for comments, backup, idempotency, explicit CLI override, no-playwright/off and devtools combination, invalid combinations; global auto/project off must resolve to off using the existing config loader.
- [ ] Add installer tests with injected provisioning seam: prepare once for enabled config; none for off/dry-run/no-deps; preparation failure yields warning result while files are written; explicit executable retained and managed path not persisted as override.
- [ ] Run compile then config/CLI/browser-v2 focused suites, observing expected failures.
- [ ] Implement migration and defaults. Read effective installer target browser config before browser provisioning; honor explicit stored choices. Back up modified Orchestra JSONC, perform atomic writes, and print bounded progress/results through existing installer output. Keep mocked tests network-free.
- [ ] Run focused suites until passing; commit `feat: enable and provision browser support during installation`.

## Task 4: Manager integration and truthful diagnostics

**Files:** Modify `src/browser/manager.ts`, `src/browser/cli.ts`, `src/browser/diagnostics.ts`, `src/browser/runtime.ts`, `src/diagnostics/doctor.ts`, `src/plugin-status.ts`, `dashboard/src/types.ts`, `dashboard/src/app.tsx`, `test/browser.test.ts`, `test/doctor.test.ts`, `test/plugin-status.test.ts`.

**Interfaces:** Manager exposes resolved `installation?: BrowserInstallation`; invokes Task 2 `ensureBrowser` before profile acquisition, using the caller signal. Extend BrowserStatus with `source: BrowserInstallation["source"] | "missing"`, optional `executable`, `buildId`, and `provisioning: "not-started" | "preparing" | "ready" | "failed"`; retain existing status fields. Errors retain specific reason/cause in a bounded displayable detail.

- [ ] Write manager integration tests: transient prior install failure retries at first launch, simultaneous starts share one preparation, canceled preparation never acquires profile lock, Chrome process startup budget begins after download completes.
- [ ] Write status/doctor tests proving discovery-only behavior and distinct disabled, not-started, missing, preparing, failed and ready states. Cached Chrome is reported without network. Login/restart uses the same resolver.
- [ ] Run targeted browser/doctor/plugin-status suites and observe expected failures.
- [ ] Integrate ensureBrowser and status fields. Clear misleading legacy static Playwright status in favor of runtime-backed browser status; keep dashboard backward-compatible with missing fields from older snapshots.
- [ ] Run focused tests plus `npm run typecheck`; commit `feat: integrate managed Chrome preparation and diagnostics`.

## Task 5: Native compatibility and dual MCP preparation

**Files:** Modify `src/browser/v2.ts`, `src/browser/runtime.ts`, `src/browser/policy.ts`, `src/v2.ts`, `test/browser-v2.test.ts`, `test/browser.test.ts`, `test/v2.test.ts`.

**Interfaces:** Extend BrowserStatus with `backends: Record<BrowserBackend, { state: "disabled" | "not-started" | "connected" | "failed"; error?: string }>`; runtime owns preparation errors and reconciles connection state through existing host methods. Keep `BrowserHost.connect` signature. No new transport abstraction.

- [ ] Reproduce native tool schema rejection using actual exported routing/control definitions and supported host schema normalization. Assert JSON schema registrations retain object properties/requiredness/enums; executor still validates input with original Zod schema. Follow current OpenCode documented JSON-schema `input` shape rather than casting incompatible schema instances.
- [ ] Add regression: a recognized renamed user MCP tool's execute function/options are unchanged and callable. Reserved-name conflict remains reported. Repeated transforms/reloads leave own managed servers non-conflicting and executors wrapped only once.
- [ ] Add runtime tests: auto attempts both connects against identical manager endpoint; single mode attempts only selected backend; UI may continue with one sufficient backend after the other fails; performance fails when DevTools fails; cancellations are not swallowed as degradation. Backend errors appear independently.
- [ ] Run browser/v2 focused suites to establish failures.
- [ ] Fix native schema bridge at registration boundaries using documented public conversion for the actual Zod versions. In native browser transform, wrap only owned registered tools; do not mutate user-managed executors. Connect backends sequentially to avoid overlapping reload races; reselect a sufficient backend using existing policy after connection outcomes, and take a fresh selected-backend snapshot. Preserve scenario ownership and shutdown semantics.
- [ ] Run focused suites until passing; commit `fix: expose both browser MCPs through native OpenCode integration`.

## Task 6: Packaged/live acceptance and user documentation

**Files:** Modify `scripts/verify-browser-package.mjs`, `scripts/run-browser-live-tests.mjs`, `test/browser-live.test.ts`, `README.md`, `README.ru.md`, `README.zh-CN.md`, `docs/browser.md`, `docs/browser-verification.md`, `examples/.opencode/orchestra.jsonc`; add `scripts/verify-browser-opencode.mjs` and an npm script to run it explicitly.

**Interfaces:** Packaged verification accepts package path and isolated working/cache directories. Native verification takes an explicit isolated OpenCode server URL/config (not the user's shared service) and uses its published OpenAPI contract. Output records versions, tool registration results and each actual backend operation; non-executed checks are not successes.

- [ ] Add package assertion that compiled download worker and direct installer dependency resolve outside the source tree, including real Node selection under Bun.
- [ ] Extend live fixture test to assert same Chrome PID/target across real Playwright navigation and DevTools inspection and persistent cookies/localStorage after restart. Explicitly force the no-system-Chrome discovery seam with a temporary cache for one opt-in real CfT download; never manipulate system Chrome to simulate absence.
- [ ] Build isolated native-host verification: load packed plugin in temporary project, assert control/routing tools present without invalid registration logs, use supported host API to drive an authorized fixture scenario through both MCPs, and close only test-owned sessions/processes. Discover endpoints from that host's OpenAPI; do not invent an API endpoint for tool invocation.
- [ ] Run `npm run check`, `npm run build`, `npm pack --ignore-scripts`, packaged verification, and `npm run test:browser-live`. Run native verification against an isolated installed OpenCode host. Record precise commands, host/platform versions, passes/failures/skips. If a prerequisite is unavailable, report the remaining acceptance gap instead of claiming complete out-of-box support.
- [ ] Update three READMEs and browser guide with defaults, fallback cache paths, official platform limitations, download=false, no-deps semantics, lazy preparation, per-backend failures and explicit mode preservation. Replace obsolete claims of no automatic downloads. Update verification report with fresh evidence and remaining unverified platforms.
- [ ] Commit `test: verify packaged browser provisioning and document setup` with scoped files, then inspect final diff and status. Do not publish.

## Execution order and handoff

Tasks 1–6 run in order; the lifecycle and interfaces are interdependent. Use an isolated workspace at execution time. Every task starts with the specified failing behavior and ends with focused passing checks. Broaden to full checks in Task 6, or earlier only when a change creates an unresolved regression concern.

- [x] Plan self-review: spec coverage, interface consistency, recovery cases, diagnostics and real-host acceptance mapped to tasks.
- [ ] User reviews plan and chooses inline or subagent-driven execution.
- [ ] Execute Tasks 1–6.
- [ ] Final independent review and evidence-based completion report.
