# OpenCode Orchestra Reliability and Routing Design

**Date:** 2026-08-27
**Status:** Approved in chat; awaiting written-spec review

## Goal

Improve Orchestra's failure containment, routing transparency, fallback quality, diagnostics, platform coverage, and parallel-editor integration without weakening existing budget controls or claiming provider interception that OpenCode does not expose.

## Delivery strategy

Work is divided into four independently testable phases. Every behavior change follows RED → GREEN → REFACTOR. Each phase must leave the full `npm run check` suite green.

1. Safe boundaries and regression coverage.
2. Transparent routing.
3. Capability-aware fallback and reliability events.
4. Routing preflight and deterministic integration diagnostics.

Runtime provider retry is conditional on an actual OpenCode interception API. If the plugin cannot observe and retry provider calls, Orchestra will expose a deterministic orchestration-level failover policy and instructions, but will not claim automatic provider retry.

## Phase 1: safe boundaries

### Invalid configuration

If `orchestra.jsonc` cannot be parsed or validated, plugin initialization continues with the schema's safe defaults. The plugin logs one warning containing the config path and a sanitized error reason. It does not overwrite the invalid file.

The fallback applies to configuration loading only. Model discovery, project registration, telemetry initialization, and agent/tool creation continue normally. Explicit runtime options that can be safely validated independently may still be applied; otherwise the entire invalid merged configuration is replaced with defaults to avoid a partially trusted state.

### Dashboard authorization

All protected snapshot, export, and configuration mutation endpoints reject missing and incorrect tokens. Rejected requests return no protected payload and cannot mutate files. Existing valid-token behavior remains unchanged.

### Sessionless routing

`orchestra_route` supports calls without `sessionID`. It produces a plan using zero prior paid calls, skips session-ledger reads and writes, and marks session accounting as unavailable. Ledger failures for a present session return a clear tool error rather than an unhandled rejection.

### Windows process fallback

`spawnWithCmdFallback` receives injectable platform and spawn dependencies for tests while retaining production defaults. Windows retry through `cmd.exe` remains fail-closed for arguments whose expansion could change command meaning. Unix behavior remains unchanged.

### CLI contracts

Built CLI smoke tests cover help, invalid commands, completion output, and `doctor --json`. Update lookup tests cover npm, Bun, and registry-fetch fallbacks plus invalid registry data.

## Phase 2: transparent routing

### Structured decision metadata

Routing decisions expose structured metadata rather than requiring consumers to parse prose:

```ts
interface RoutingReason {
  code: string
  text: string
  matchedCapabilities: string[]
  score?: number
  budget: BudgetMode
}
```

`code` is a stable machine-readable identifier. `text` is diagnostic copy and is not a compatibility contract. No secrets, prompts, tokens, filesystem contents, or provider credentials may appear in either field.

The selected model and reason flow into `orchestra_route`, session telemetry where available, plugin status, and dashboard snapshots. Existing response fields remain available to avoid unnecessary breakage.

### Classifier matrix

Golden tests cover every orchestration profile and known confusing profile pairs. These tests stabilize current intent; they do not introduce adaptive or learned classification.

## Phase 3: fallback and reliability policy

### Candidate ordering

Fallback candidates are filtered and ranked in this order:

1. Required capability compatibility.
2. Provider/model availability.
3. User priority and suitable model tier.
4. Budget eligibility and preferred cost class.
5. Estimated price.
6. Model ID as a deterministic final tie-breaker.

Unknown capability metadata lowers confidence but does not automatically remove a candidate. A candidate explicitly known to lack a required capability is excluded.

### Error policy

| Error class | Policy |
| --- | --- |
| Rate limit / 429 | Move to the next compatible candidate |
| Timeout / 408 | Move to the next compatible candidate |
| Provider 5xx / overloaded | Move to the next compatible candidate |
| Authentication / 401 / 403 | Stop; configuration error |
| Invalid request / unsupported capability | Stop; routing or request error |
| Unknown error | Stop unless explicitly classified retryable |

Every sequence has a maximum attempt count, never retries the same model, and preserves the original failure. Paid-call limits remain authoritative.

### Reliability events

Where Orchestra can observe execution, ledger events record the attempted model, error class, next model, attempt number, and final outcome. Text is sanitized and bounded. If provider calls cannot be intercepted, equivalent policy metadata is returned to `orch-lead`; no fabricated execution event is recorded.

## Phase 4: preflight and integration diagnostics

### Routing doctor

The existing `doctor` gains non-destructive routing checks for:

- invalid or empty pools;
- unavailable exact agent overrides;
- roles with no eligible candidate;
- missing required capabilities;
- paid-only routes blocked by budget policy;
- fallback chains containing no compatible alternative;
- unknown pricing, reported as a warning rather than as free;
- duplicate candidates and deterministic-order violations.

Warnings do not block valid partial configurations. JSON output uses stable check identifiers and severity values.

### Parallel-editor conflict map

Before integration, Orchestra validates actual changed files against declared ownership and performs a non-mutating Git conflict probe. The report includes editor identity, commit, changed paths, ownership violations, conflict paths, and deterministic integration order.

Any ownership violation, ancestry failure, or Git conflict stops automatic integration. Worktrees are retained for diagnosis. A clean textual merge is not treated as proof of semantic correctness; normal tests and review remain mandatory.

## Security and privacy constraints

- Never expose dashboard data without a valid token.
- Never place credentials, raw prompts, or full provider responses in routing reasons or reliability events.
- Bound diagnostic strings and redact known secret forms.
- Do not retry authentication failures.
- Do not mutate invalid user configuration during fallback initialization or `doctor` checks.
- Preserve fail-closed Windows command handling.

## Compatibility constraints

- Keep Node.js `>=22` and Bun `>=1.2` support.
- Add no production dependency unless repository evidence shows it is necessary.
- Preserve existing configuration fields and response fields where practical.
- Schema additions must be optional and receive safe defaults.
- Continue to report unknown pricing as `unknown`, never `free`.

## Verification

Each vertical slice must demonstrate a failing test before production changes. Targeted tests run first, followed by:

```bash
npm run typecheck
npm test
npm run build
```

Platform-dependent behavior is tested through dependency injection; native Windows CI remains desirable but is not required to test the command-construction policy. Dashboard authorization tests must verify both response denial and absence of filesystem mutation.

## Out of scope

- Machine-learned or self-tuning model routing.
- Automatic resolution of semantic merge conflicts.
- New dashboard visualization families without reliability data to display.
- Provider-call interception unsupported by the OpenCode plugin API.
- Breaking configuration redesign.

## Success criteria

1. Invalid user configuration no longer prevents plugin startup and is never overwritten.
2. Protected dashboard endpoints have positive and negative authorization coverage.
3. Routing works deterministically without a session and reports ledger failures clearly.
4. Windows fallback behavior is fully testable off Windows without weakening command safety.
5. Users can see a sanitized, structured reason for routing decisions.
6. Fallback never selects a candidate explicitly incompatible with the required capability.
7. Retryable and terminal failures follow the documented policy with bounded attempts.
8. `doctor` detects unusable routing configurations before orchestration starts.
9. Integrator stops safely and preserves worktrees when ownership or Git conflict checks fail.
10. The full typecheck, test, and build pipeline passes after every phase.
