# Managed browser implementation verification

Checked on Windows on 2026-10-02, using Node 26.7.0 and the installed Bun runtime. This report distinguishes executable/package checks, mocked native-host tests, and unavailable live checks.

## Implemented files

| Area | Files |
| --- | --- |
| Chrome lifecycle and persistent ownership | `src/browser/manager.ts`, `src/browser/profile.ts` |
| Shared role/contract policy and backend choice | `src/browser/policy.ts`, `src/browser/runtime.ts` |
| Native OpenCode V2 MCP/tool integration | `src/browser/v2.ts`, `src/v2.ts`, `src/index.ts` |
| Pinned local MCP execution and management | `src/browser/packages.ts`, `src/browser/cli.ts`, `src/cli.ts`, `src/diagnostics/completion.ts` |
| Existing orchestration integration | `src/orchestration/contracts.ts`, `src/orchestration/run-state.ts`, `src/routing/planner.ts`, `src/tools.ts` |
| Loaded browser instructions and agent permissions | `src/agents/build.ts`, `src/prompts/load.ts` |
| Configuration and migration rules | `src/config/schema.ts`, `schema/opencode-orchestra.schema.json`, `examples/.opencode/orchestra.jsonc` |
| Offline diagnostics, status and smoke exclusions | `src/browser/diagnostics.ts`, `src/diagnostics/doctor.ts`, `src/plugin-status.ts`, `src/mcp/config-smoke.ts`, `src/mcp/catalog.ts` |
| Existing ledger/dashboard | `src/telemetry/ledger.ts`, `src/dashboard/server.ts`, `dashboard/src/app.tsx`, `dashboard/src/types.ts`, `dashboard/src/lib/locales.ts` |
| Dependencies, documentation and explicit test inclusion | `package.json`, `package-lock.json`, all three README languages, `docs/browser.md` |
| Unit/native-host/installer tests | `test/browser.test.ts`, `test/browser-v2.test.ts`, related agent/completion assertions |
| Live fixture and separate regression | `test/browser-live.test.ts`, `test/fixtures/browser-site.ts`, `test/fixtures/browser-regression.spec.ts`, `test/browser.playwright.config.ts`, `scripts/run-browser-live-tests.mjs` |
| Installed-package verification | `scripts/verify-browser-package.mjs` |

Pre-existing workspace changes were preserved. This table describes browser work, not all dirty files in the checkout.

## Commands actually completed

- `npm run check`: **472 tests, 471 passed, 0 failed, 1 skipped**; type checking and test compilation passed. The normal test command explicitly includes the new browser files.
- `npm run build`: dashboard and plugin JavaScript/declarations built successfully. Vite reported its existing large-chunk warning.
- `npm run test:browser-live`: **0 passed, 1 skipped**, because Chrome is missing. No persistent user profile was touched.
- `npm run test:browser-e2e`: **1 skipped**, because no explicitly installed Chrome/Playwright Chromium is available.
- `npm pack --ignore-scripts --cache .orchestra-test-report/npm-pack-cache --json`: created `oeronteros-1-opencode-orchestra-3.0.0.tgz` with 297 entries. All eight browser JavaScript modules, declarations, browser instructions and schema are included. No browser executable, profile, `DevToolsActivePort`, source test files or `node_modules` are bundled.
- `npm install --prefix <temporary-root> <local-tarball> --offline --omit=dev --ignore-scripts --no-audit --no-fund`: installed 303 packages from the npm cache outside the repository. The final temporary path contains a space and Unicode. This install made no registry requests or lifecycle-script calls.
- Installed `dist/cli.js browser status --directory <temporary-project>`: packages installed, genuine Node available, Chrome unavailable, mode off for omitted configuration, profile unlocked. Status did not start a browser or connect CDP.
- Installed-package verification under both Node and Bun: imported the plugin's native setup and legacy server exports; resolved both exact MCP versions inside the temporary installation; executed both local MCP `--help` commands. Under Bun, the generated MCP command was also checked to use genuine Node. No source-tree module or `npx` was used.
- Invoked the pinned DevTools argument parser with the actual generated flags: browser URL matched the loopback endpoint, usage statistics and CrUX were false, sensitive-header redaction true, page-ID routing false, filesystem root restricted to the artifact directory.
- `git diff --check` passed for the browser/integration changes.

Local logs are in `.orchestra-test-report/` (not shipped). To repeat package execution checks after installing a tarball, use `node scripts/verify-browser-package.mjs <temporary-root>` or the equivalent Bun command. This verifies CLI execution and package resolution; it does not claim browser connectivity.

## Tested boundaries

The browser tests cover configuration/defaults, installer preservation, task-based backend selection, actual prompt loading, role/contract/resource checks, trusted native executor wrapping, rejected direct invocation, disabled Code Mode, cross-run scenario ownership, a real interprocess lock conflict, worktree identity, one manager across handoff, snapshot freshness, JavaScript hidden inside navigation, trace reload authorization, cancellation during execution, timeout signaling, ambiguous mutations, checkpoint restore, browser-crash isolation from ordinary scheduling, safe ledger records, diagnostic whitelisting, export-path confinement, truncation and active-owner artifact retention. Native OpenCode interfaces use a typed test harness, not a running OpenCode server.

The live test is implemented with two real pinned MCP clients and a temporary test-only profile. It checks one Chrome PID, common signed-in state, observations started before an HTTP 503/console failure, and persistent cookie/localStorage after graceful restart. It does not require sessionStorage persistence. These live assertions were **not executed** on this machine.

## Practical limits and first login

Follow [the browser configuration and login guide](browser.md). Managed execution requires OpenCode V2 2.0.16 or newer, Node >=22.12 and separately installed Chrome. New installer configurations use auto; existing configurations remain untouched and an omitted browser section means off.

Only one real page tab and one scenario are supported per owning runtime. Independent parallel accounts require separate named profiles/processes. Code Mode, external file uploads and Playwright server-process unsafe code execution are disabled. Lead verification is restricted to observation/navigation of a completed sealed browser node. Unknown/orphan locks are never stolen. Artifact expiration occurs on later preparation and preserves live or unknown owners.

First configure `browser.mode` and named profiles, then run `opencode-orchestra browser login --directory <project> --profile default`. In this checkout the equivalent command is `node dist/cli.js browser login --directory . --profile default`. Sign in directly in visible Chrome, then close Chrome or press Ctrl+C before using the same profile from OpenCode. Profile data lives outside the project and package; site-side expiry still requires renewed login.

Live OpenCode V2 integration, real Chrome lifecycle/CDP behavior, and actual Linux/macOS executable/process cleanup remain **unverified** here. There is no browser-binary download or claim that skipped live checks passed. No package publication or git push was performed.
