# Managed browser

Managed browsing requires OpenCode **V2 2.0.16 or newer**, real **Node >=22.12** and a separately installed Chrome. Legacy OpenCode continues to orchestrate repository work; its adapter cannot safely request permissions or manage dynamic MCP catalogs for this subsystem. No extension is required. Browser binaries are not included or downloaded during Orchestra installation. Install Chrome explicitly, or set an absolute `browser.executable` pointing to Chrome for Testing. `browser.nodeExecutable` is useful when OpenCode runs under Bun.

New `install` configurations contain `browser.mode=auto`. Existing `orchestra.jsonc` and user MCP entries are preserved, including under `--force`; omitted browser configuration means **off**. `--no-playwright` scaffolds **off** for a new installation; `--no-playwright --browser-mode devtools` explicitly selects DevTools only. Combining that flag with `auto` or `playwright` is an error. `--dry-run` does not provision or launch anything. `--no-deps` still skips companion provisioning; the pinned browser MCPs are ordinary dependencies of the installed Orchestra npm package. Starting an installed MCP uses Node and an absolute local script, without `npx`, `@latest`, or new npm downloads.

```jsonc
{
  "browser": {
    "mode": "auto",
    "profile": "default",
    "profiles": ["default", "work-account"],
    "sharedProfiles": [],
    "headless": false,
    "maxOutputChars": 16000,
    "artifactRetentionHours": 24
  }
}
```

Modes are `off`, `playwright`, `devtools`, and `auto`. UI/navigation/forms prefer Playwright. Console and network inspection reuse the active backend. Deep diagnostics and performance require DevTools. Documentation uses webfetch/websearch/Context7; E2E reproduction is a Playwright Test in the repository, written within an editor's allowed scope. A fallback may use an available sufficient backend in auto, but cannot override an explicit mode or invent performance capability.

## First login and profiles

Run `opencode-orchestra browser login --directory /path/to/project --profile default`. Sign in directly in the visible managed Chrome window. Close Chrome or press Ctrl+C to flush profile state and release ownership. Do not send passwords, tokens or 2FA codes to the agent. Close the login command before asking OpenCode to use that same profile; competing owners fail with `browser_profile_busy`.

Profiles live under the user's Orchestra data directory: `%LOCALAPPDATA%/OpenCodeOrchestra` on Windows, `~/Library/Application Support/OpenCodeOrchestra` on macOS, and `$XDG_DATA_HOME/opencode-orchestra` (otherwise `~/.local/share/opencode-orchestra`) on Linux. A profile key combines the canonical Git common directory hash and a configured name. Git worktrees share that identity; unrelated clones remain separate. Non-Git projects use their canonical directory. Moving/cloning a repository changes its identity. Only names explicitly listed in `sharedProfiles` are shared across projects. Different tabs share cookies and are not account isolation.

Persistent cookies and site data such as localStorage can survive a browser restart. Authentication may still expire or be revoked by the site. sessionStorage is tab-specific; full tab/session restoration and permanent authentication are not promised. Orchestra updates and reinstall do not remove browser profiles. Expired authentication requires another visible login, never an automatic profile wipe or cookie export.

`browser status` separates configuration, pinned package installation, Chrome/Node availability and profile lock state. Live connections and browser state are available through `orchestra_browser status` and plugin-status/dashboard. `browser profiles` lists configured account names. `browser select --profile work-account` writes a project override; restart OpenCode to load it. `browser restart` opens a newly owned visible browser and refuses another process's lock. In OpenCode, `orchestra_browser restart` stops this plugin's browser after releasing its scenario; the next prepare restarts it. `browser reset --profile default --confirm default` is a separate destructive user command and refuses locked or symlink profiles. Unknown/orphan locks are retained; inspect processes before manual repair. No ordinary user Chrome is terminated.

## Contracts and runtime enforcement

The lead supplies `orchestra_route.browser`, for example:

```json
{
  "task": "Verify the sign-in flow on the local fixture",
  "profile": "debug",
  "browser": {
    "profile": "default",
    "task": "ui",
    "origins": ["http://127.0.0.1:3000"],
    "operations": ["observe", "navigate", "interact"]
  }
}
```

The route seals the grant and `browser:default` exclusive resource on an existing specialist, normally orch-tests. All existing worker, delegation, budget and verification gates remain in effect. The dispatched runtime session calls `orchestra_browser prepare`, gets the chosen MCP catalog, takes a fresh snapshot, reproduces the scenario, collects evidence, verifies, and then releases it. Lead final verification requires a completed sealed browser node and is restricted to observation/navigation. Browser access does not grant file editing. Security and visual-review cannot execute arbitrary JS or mutate accounts; visual-reference can only observe/navigate. Other specialists consume evidence without browser access. A browser grant cannot be introduced by nested delegation. Model-supplied session/owner IDs are never accepted.

Access is checked inside each native MCP executor using OpenCode's trusted agent/session/tool context. Native user permissions still apply; autoAcceptAll is not enabled by this feature. Direct user-managed browser servers are not taken over, and detected Playwright/DevTools servers (including renamed entries) block creating a managed duplicate. Remove/reconfigure a conflicting user server explicitly if choosing managed browsing. Reserved Orchestra server names are never overwritten.

There are two locks: a directory lock establishes a single process owner per profile; an in-memory scenario lease covers reproduction, evidence and verification across runs in that owner. The implementation **serializes scenarios and requires one real page tab**. Extra tabs, changed targets and backend-specific foreign identifiers are rejected. A handoff requires a reason, selects the sole target independently in each backend, and requires a new model-visible snapshot; MCP refs/indexes/page IDs are never transferred. Independently parallel scenarios require separate profiles and separate OpenCode processes. There is no claim of safe parallel tab routing.

The pinned native SDK provides `ctx.mcp.transform/reload`, tool transforms and trusted execution hooks, session context hooks, permission evaluation, and plugin cleanup. It does not expose arbitrary permission-request creation through `ctx.permission`; the legacy `context.ask()` bridge remains unavailable in V2. Browser tools therefore use native tool permission evaluation. MCP transport and connections are owned by OpenCode. A thin executor wrapper supplies the missing scenario/contract boundary and bounded result handling. Browser Code Mode is explicitly disabled until native end-to-end permission and attribution can be verified; wrappers also reject direct invocation without a lease. No token-saving claim is made.

## Failures, evidence and privacy

Chrome starts on the first real task (or explicit login), uses an ephemeral local debugging port, and is checked against the spawned PID, profile lock, fresh DevToolsActivePort and browser WebSocket identity. MCPs attach via `--cdp-endpoint` / `--browser-url`, never launch a second browser on that profile. No personal profile, extension, `--no-sandbox`, or Chrome confirmation bypass is used. Loopback is **not authentication** against other local processes; those processes may access CDP while it is open.

Missing Chrome, conflicting profiles, MCP failure or Chrome crash produce bounded failure codes while ordinary Orchestra remains available. Uncertain mutations are not automatically retried: inspect fresh state first. Interrupted browser nodes restore as blocked; explicit inspection/retry is required before external mutations resume. Cancellation and plugin cleanup release owned resources while retaining profiles. Backend shutdown is delayed until scenario ownership ends; an inactive backend is retained during a handoff rather than disconnected underneath another call.

Start network observation before reproduction. Requests that were not observed cannot be reconstructed. Text snapshots precede screenshots; prefer relevant network lists before detailed request/response bodies. Results exceeding `maxOutputChars` explicitly report truncation and a private artifact file. Old artifact directories expire on subsequent browser preparation after the configured retention period; live owners and unknown ownership records are retained. There is no background deletion promise. Tracing/video are not enabled by default. File uploads and Playwright's RCE-equivalent `browser_run_code_unsafe` are refused because there is no safe external-file permission bridge. Page-context JS requires an explicit evaluate grant and is never classified read-only; this also applies to DevTools navigation `initScript`. A performance trace that reloads the page additionally requires a navigation grant. All supported file exports stay inside the private artifact directory.

DevTools usage statistics, CrUX and update checks are disabled, and sensitive-header redaction remains on. Ledger browser attribution contains backend, runtime agent, root run/node, tool name, duration, success and output size; it never stores MCP arguments/results, URLs, credentials, bodies or storage dumps. Redaction does not protect all secrets: pages, screenshots and private artifacts may contain sensitive data. Model transcripts and explicitly enabled Orchestra text logging should be handled accordingly.

Report checked behavior, expected/actual result, reproduction steps, backend, artifact links and remaining limitations. A screenshot alone is not evidence that a scenario passed.

## Verification

`npm test` explicitly includes browser unit/native-bridge/installation tests and an opt-in live test. `npm run test:browser-live` uses a new temporary test-only profile and a loopback fixture with persistent auth cookie, localStorage, controlled JS exception and HTTP 503. Set `ORCHESTRA_TEST_CHROME` to an absolute Chrome executable when needed. Without Chrome it reports **skipped**, not passed. `npm run test:browser-e2e` runs the separate Playwright regression test (requires an explicitly installed Playwright Chromium). Smoke never connects configured authenticated browser profiles. Doctor remains offline and non-destructive.

API/source references: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp). Tested package versions: `@opencode/plugin 2.0.16`, `@playwright/mcp 0.0.83` (its pinned CDP connection uses the existing default context, without isolated mode), `chrome-devtools-mcp 1.10.1`.
