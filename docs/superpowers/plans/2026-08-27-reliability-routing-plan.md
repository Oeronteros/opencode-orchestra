# OpenCode Orchestra Reliability and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved reliability, routing transparency, fallback, diagnostics, platform-safety, and integration improvements as four independently verifiable phases.

**Architecture:** Preserve existing module boundaries and add small pure policy helpers where behavior is currently implicit. Phase 1 hardens boundaries and contracts; Phase 2 carries structured routing metadata; Phase 3 makes fallback policy capability-aware and records only observable reliability events; Phase 4 extends existing doctor and integrator validation without adding a parallel diagnostic or merge subsystem.

**Tech Stack:** TypeScript, Node.js 22, Bun, `node:test`, `assert/strict`, Zod, JSONC parser, native `node:child_process`, Git worktrees, existing dashboard HTTP server and ledger.

**Spec:** `docs/superpowers/specs/2026-08-27-reliability-routing-design.md`

## Global Constraints

- Keep Node.js `>=22` and Bun `>=1.2` support.
- Add no production dependency unless repository evidence shows it is necessary.
- Preserve existing configuration fields and response fields where practical.
- Schema additions must be optional and receive safe defaults.
- Continue to report unknown pricing as `unknown`, never `free`.
- Never retry authentication failures.
- Never expose dashboard data without a valid token.
- Never place credentials, raw prompts, or full provider responses in routing reasons or reliability events.
- Preserve fail-closed Windows command handling.
- Every production behavior change requires a failing test before implementation.
- After each task run its targeted tests; after each phase run `npm run typecheck` and `npm test`.

## File map

- `src/config/load.ts`, `src/index.ts`: safe config loading and startup warning.
- `src/dashboard/server.ts`, `test/dashboard.test.ts`: protected endpoint behavior.
- `src/tools.ts`, `test/plugin.test.ts`: sessionless routing and structured route output.
- `src/spawn.ts`, `test/spawn-fallback.test.ts`: injectable Windows process fallback.
- `src/diagnostics/update.ts`, `test/diagnostics-update.test.ts`: update lookup contracts.
- `src/cli.ts`, `test/cli-smoke.test.ts`: built CLI process contract.
- `src/routing/classifier.ts`, `test/classifier.test.ts`: profile golden matrix.
- `src/routing/model-resolver.ts`, `src/routing/fallback.ts`, `test/model-resolver.test.ts`, `test/fallback.test.ts`: reason metadata, capability-aware ordering, and error policy.
- `src/telemetry/ledger.ts`, `test/ledger.test.ts`: bounded reliability events.
- `src/diagnostics/doctor.ts`, `test/doctor.test.ts`: routing preflight.
- `src/orchestration/ownership.ts`, `src/agents/integrator.ts`, `test/ownership.test.ts`, `test/worktrees.test.ts`: deterministic conflict reporting.
- `README.md`, `schema/opencode-orchestra.schema.json`: user-visible contracts and optional configuration documentation.

---

## Phase 1 — Safe boundaries and regression contracts

### Task 1: Graceful invalid-config startup

**Files:**
- Modify: `src/index.ts:209-217`
- Modify: `src/config/load.ts:47-73` only if a reusable safe loader is needed
- Test: `test/plugin.test.ts`

**Interfaces:**
- Consume existing `loadConfig(directory, rawOptions): Promise<LoadedConfig>` and `DEFAULT_CONFIG`.
- Produce plugin startup that logs a bounded warning and uses `DEFAULT_CONFIG` when parsing or schema validation fails.

- [ ] Write a test with a temporary project config containing truncated JSONC; initialize `OrchestraPlugin` with a log collector; assert initialization resolves, tools/agents exist, and the log contains the config path and an invalid-config warning.
- [ ] Run `npm run test -- --test-name-pattern='invalid config'` through the repository's compile-to-`dist-test` flow and verify the new test fails because initialization rejects.
- [ ] Implement a narrow catch around config loading that replaces the invalid merged configuration with safe defaults and logs only sanitized error text; do not write to the source file.
- [ ] Add a schema-violation case and assert the same fallback behavior.
- [ ] Run the two targeted tests and then `npm test`.

### Task 2: Dashboard authorization negatives

**Files:**
- Modify: `test/dashboard.test.ts`
- Modify: `src/dashboard/server.ts` only if tests reveal a missing protected route or mutation issue

**Interfaces:**
- Preserve `startDashboard(options): Promise<{url, close}>` and the existing valid-token behavior.

- [ ] Add tests for missing and incorrect tokens on `/api/snapshot`, `/api/export`, `/api/config`, and `/api/config/validate`.
- [ ] Capture the config file before unauthorized mutation attempts; assert status `401`, no protected payload, and byte-for-byte unchanged config.
- [ ] Run the targeted dashboard test and verify it fails if any route is insufficiently protected.
- [ ] Implement only the minimal route/auth correction required by the failing assertion.
- [ ] Run `node --test dist-test/test/dashboard.test.js` and the full test suite.

### Task 3: Sessionless route and ledger failure contract

**Files:**
- Modify: `src/tools.ts:112-143`
- Test: `test/plugin.test.ts`

**Interfaces:**
- Preserve `orchestra_route.execute(args, context): Promise<string>`.
- Sessionless calls use zero prior paid calls and do not call ledger session methods.

- [ ] Add a test invoking `orchestra_route` with `{}` context; assert a valid plan, `paidCallsUsed === 0`, and no failure.
- [ ] Add a test with a present session whose ledger lookup fails; assert a readable JSON error rather than an unhandled rejection.
- [ ] Run both tests and verify the new failure case fails before implementation.
- [ ] Guard only the session-dependent ledger access and return a stable error object for lookup failures.
- [ ] Run plugin tests and the full suite.

### Task 4: Injectable Windows spawn fallback

**Files:**
- Modify: `src/spawn.ts:42-49`
- Modify: `test/spawn-fallback.test.ts`

**Interfaces:**
- Extend `spawnWithCmdFallback(command, args, options, deps?)` with optional internal/test dependency injection for `platform` and `spawnSync`; production defaults remain unchanged.

- [ ] Add a fake-spawn test for `win32` where direct spawn returns `EINVAL` and shell retry succeeds; assert the retry command and `shell: true`.
- [ ] Add a test where `%VAR%` appears and assert no retry.
- [ ] Run targeted tests and verify they fail because the current function always reads the real platform and spawn implementation.
- [ ] Implement dependency injection without changing the public default call sites.
- [ ] Run spawn tests on the current platform and all tests.

### Task 5: Update and CLI contracts

**Files:**
- Create: `test/diagnostics-update.test.ts`
- Create: `test/cli-smoke.test.ts`
- Modify: `src/diagnostics/update.ts` only if invalid registry responses expose a defect
- Modify: `src/cli.ts` only if a command contract is broken
- Modify: `package.json` test script to include the new test files

**Interfaces:**
- Preserve `latestPublishedVersion(): Promise<string | undefined>` and `formatUpdateResult`.
- CLI remains executable through `dist/cli.js`.

- [ ] Add update tests for npm success, npm failure followed by Bun, both failures followed by fetch 500, invalid semver registry data, and pre-release current versions.
- [ ] Run update tests and verify each newly specified behavior fails if unsupported.
- [ ] Implement minimal validation/fallback corrections.
- [ ] Add CLI process tests for `--help`, an unknown command, `completion zsh`, and offline `doctor --json` using a temporary config directory.
- [ ] Build test sources and run the smoke tests; then run the full suite.

---

## Phase 2 — Transparent routing

### Task 6: Structured routing reason

**Files:**
- Modify: `src/routing/model-resolver.ts`
- Modify: `src/tools.ts`
- Modify: `src/plugin-status.ts` or dashboard snapshot producer where the existing route/status payload is assembled
- Test: `test/model-resolver.test.ts`, `test/plugin.test.ts`

**Interfaces:**
- Add an exported `RoutingReason` with `code`, `text`, `matchedCapabilities`, optional `score`, and `budget`.
- Extend the resolver result with optional `reason`; preserve `id` and existing score/selection fields.

- [ ] Write resolver tests asserting stable reason codes for exact override, manual pool, auto capability match, budget exclusion, and current-model fallback.
- [ ] Run targeted tests and verify the new assertions fail.
- [ ] Implement reason construction with bounded, secret-free fields.
- [ ] Add route-output assertions ensuring `model` and structured `reason` reach `orchestra_route` without removing existing fields.
- [ ] Run routing/plugin tests and the full suite.

### Task 7: Classifier golden matrix

**Files:**
- Modify: `test/classifier.test.ts`
- Modify: `src/routing/classifier.ts` only when a test demonstrates an incorrect existing classification

- [ ] Add table-driven positive cases for all nine profiles.
- [ ] Add negative/confusion cases for debug vs architecture, security vs generic review, and UI vs research.
- [ ] Run the classifier file and confirm any mismatch fails with its task and expected profile visible.
- [ ] Correct only proven classification defects, retaining deterministic fallback behavior.
- [ ] Run classifier tests and full suite.

---

## Phase 3 — Capability-aware fallback and reliability policy

### Task 8: Explicit error policy and capability-aware ordering

**Files:**
- Modify: `src/routing/fallback.ts`
- Modify: `src/routing/model-resolver.ts` only for shared capability scoring helpers
- Modify: `test/fallback.test.ts`, `test/model-resolver.test.ts`

**Interfaces:**
- Preserve `classifyError`, `isRetryable`, `buildFallbackChain`, and `nextAfterFailure` signatures unless an additive options field is required.
- Add stable policy helpers only if they are pure and directly tested.

- [ ] Add tests proving explicit capability incompatibility excludes a candidate, unknown capability metadata remains eligible but lower confidence, and a compatible candidate outranks an incompatible cheaper candidate.
- [ ] Add tests for the policy table: rate-limit, timeout, 5xx retry; auth and invalid-request stop.
- [ ] Run targeted tests and verify the new tests fail against cost-only alternative sorting.
- [ ] Implement deterministic ordering: compatibility, availability, priority/tier, budget, cost, ID.
- [ ] Ensure unknown costs remain `unknown` and never become free through fallback conversion.
- [ ] Run fallback/model tests and full suite.

### Task 9: Observable reliability events

**Files:**
- Modify: `src/telemetry/ledger.ts`
- Modify: `src/tools.ts` or the actual observable execution boundary identified during implementation
- Test: `test/ledger.test.ts`, `test/plugin.test.ts`

**Interfaces:**
- Add a bounded reliability event type containing session, attempt, model, error kind, next model, and outcome.
- Add an additive ledger method such as `recordReliabilityEvent(sessionID, event)` that is a no-op for unavailable session context.

- [ ] Write ledger tests for event persistence, bounded/sanitized error text, and preservation through state reload.
- [ ] Add an integration test for a retryable failure and assert one failure plus one transition event; add a terminal-auth failure asserting no retry event.
- [ ] Run tests and verify the integration test fails before runtime wiring.
- [ ] Implement event recording only where the plugin genuinely observes the attempt; if provider interception is unavailable, return policy metadata without fabricating an event.
- [ ] Run ledger/integration tests and full suite.

---

## Phase 4 — Preflight and integration diagnostics

### Task 10: Routing checks in doctor

**Files:**
- Modify: `src/diagnostics/doctor.ts`
- Modify: `src/cli.ts` only if option plumbing is needed
- Modify: `test/doctor.test.ts`

**Interfaces:**
- Extend `DoctorReport` with stable check IDs and severity for routing checks while preserving existing JSON fields.

- [ ] Add tests for empty pools, unavailable exact overrides, no compatible capability candidate, paid-only route blocked by policy, unknown pricing warning, and valid partial configurations.
- [ ] Run doctor tests and verify the new checks fail before implementation.
- [ ] Implement non-mutating checks using existing config loading and resolver/fallback helpers.
- [ ] Assert text and JSON output are deterministic and warnings do not block valid partial configs.
- [ ] Run doctor tests, CLI tests, and full suite.

### Task 11: Deterministic editor conflict map

**Files:**
- Modify: `src/orchestration/ownership.ts`
- Modify: `src/agents/integrator.ts`
- Modify: `test/ownership.test.ts`, `test/worktrees.test.ts`, `test/integration.test.ts`

**Interfaces:**
- Add a pure conflict-report function returning editor identity, commit, changed paths, ownership violations, conflict paths, and deterministic order.
- Integrator consumes the report and stops automatic integration on ownership, ancestry, or Git conflict failure while retaining worktrees.

- [ ] Add pure tests for overlapping files, path-boundary non-overlap, ownership violations, deterministic ordering, and clean partitions.
- [ ] Add an integration test for a simulated Git conflict and assert no destructive cleanup occurs.
- [ ] Run targeted tests and verify the new assertions fail.
- [ ] Implement report generation and wire it into the existing integrator validation path; do not auto-resolve semantic conflicts.
- [ ] Run ownership/worktree/integration tests and full suite.

### Task 12: Documentation and optional schema contracts

**Files:**
- Modify: `README.md`
- Modify: `schema/opencode-orchestra.schema.json` only for additive, optional fields actually implemented
- Test: relevant config/schema tests

- [ ] Add documentation for invalid-config fallback, reason codes, retry policy, capability-aware fallback, doctor routing checks, and retained conflict worktrees.
- [ ] Add optional schema descriptions/defaults for any new user-facing configuration fields; do not add knobs that implementation does not need.
- [ ] Run schema/config tests and inspect generated examples for consistency.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`.

## Final verification

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and confirm the command includes every new test file.
- [ ] Run `npm run build`.
- [ ] Inspect `git diff --check` and `git status --short`.
- [ ] Review that no credentials, raw prompts, or generated build artifacts were added unintentionally.
- [ ] Report changed files, tests, build result, and any provider-interception limitation explicitly.

## Self-review

- Spec coverage: all Phase 1–4 requirements map to Tasks 1–12; out-of-scope ML routing and semantic auto-merge are explicitly excluded.
- Placeholder scan: no `TBD`, `TODO`, or unspecified “handle later” steps are present.
- Type consistency: `RoutingReason`, reliability event fields, and doctor/conflict report outputs are additive and consumed only after their defining task.
- Scope: the work is intentionally staged; each task has a targeted test cycle and later tasks depend only on earlier public contracts.
