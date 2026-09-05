# Git + ast-grep MCP Integration Design

**Date:** 2026-09-06
**Status:** Approved in chat (5/5 sections); awaiting written-spec review
**Path:** Bounded → upgraded to Architectural (cross-cutting: installer, agent permissions, prompts, doctor, dashboard, docs, tests)

## Goal

Add two companion MCP servers to the Orchestra plugin build with full parity to the existing stack (Context7, Codebase Memory, MemoryGraph, Playwright), and wire them to agents through a closed verification loop:

1. Planning — MemoryGraph (ADR) + Git MCP (history/PR).
2. Structural analysis — Codebase Memory (call graph) + ast-grep (syntactic patterns).
3. External contracts — Context7.
4. Modification — ast-grep rewrite / file edits.
5. Verification — built-in `bash` (tests, linters, build) with truncated logs.
6. Result fixation — MemoryGraph (ADR record) + Git (commit, gated on green tests).

No separate Terminal MCP is installed; verification uses the built-in `bash` tool plus `rg` for text search in non-code files. No separate Ripgrep MCP is needed.

## Decisions log (chat-approved)

- **MCP distributions:** Git = official `mcp-server-git` via `["uvx", "mcp-server-git"]` with NO `--repository` flag (variant A). ast-grep = `["uvx", "--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"]`. Rationale: server starts without args; tools take dynamic `repo_path`; relative paths resolve from the project cwd that OpenCode inherits when spawning MCPs from the global config. Variants B (placeholder path) and C (install-dir path) rejected: placeholder crashes or queries a nonexistent repo; install-dir path pins Git MCP to the installer directory across projects.
- **Agent wiring:** lead gets `git_* + ast-grep_*`; repo gets `ast-grep_* + git_*` without `bash`, read-only; editor gets `ast-grep_*` (critical for rewrite) without `bash`/`git_*`; integrator gets NO external `git_*` (keeps deterministic internal worktree adapter, avoids adapter-vs-MCP competition and worktree path confusion); tests unchanged (`bash: allow`).
- **Safety:** variant B — hard engine-level `deny` + strict system prompts (prompt-only fallback if the engine type does not support granular deny; verified at `npm run typecheck`, recorded here as a risk).
- **Build scope:** variant A — full parity (flags, config, `uvx` cache warmup, offline doctor, presence + dashboard). Warmup-failure still writes config because `uvx` is an autonomous runtime and transient network failures must not block configuration. `--no-deps` skips warmup only.
- **Editor prompt tail:** fixed as «use standard file reading and patch editing tools instead» — NO «use rg via bash» because `orch-editor` has no `bash`; otherwise the model hallucinates a missing tool.
- **Doctor levels:** `warning` for missing `git`/`uvx` (guaranteed server failure at launch), `info` for missing system `ast-grep`/`sg` binary (server may carry built-in bindings; binary is a speed/local-parsing recommendation). Strictly offline.

## Section 1/5 — Build: CLI, flags, config generation, `uvx` warmup

**Touched file:** `src/cli.ts` only (tests in Section 5).

### 1.1 Options and flags

Extend `InstallOptions` mirroring `codebaseMemory`/`memoryGraph` style:

```ts
git: boolean
astGrep: boolean
```

Defaults `true`. Parsing: `--no-git` sets `git=false`, `--no-ast-grep` sets `astGrep=false`. Update `usage()` «Install options» with both lines next to `--no-context7`, and mirror in README `--help` quote. Absent flag means install; `--no-deps` does not cancel config writes, only warmup (see 1.3).

### 1.2 Config generation (`addMcp`, kebab-case)

Reuse existing `addMcp(name, value)` preserve-unless-`--force` semantics:

```jsonc
// mcp.git
{ "type": "local", "command": ["uvx", "mcp-server-git"], "enabled": true, "timeout": 30000 }
// mcp.ast-grep
{ "type": "local", "command": ["uvx", "--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"], "enabled": true, "timeout": 30000 }
```

Keys are kebab-case (`git`, `ast-grep`) for consistency with `codebase-memory`. Timeout 30s matches `playwright`/`codebase-memory` (survives warm start, does not hang forever). `dryRun` computes `changed`/`preserved` without writing and without warmup (existing behavior).

### 1.3 `uvx` cache warmup (cold-start guard)

New step after `provisionCodebaseMemory`/`provisionMemoryGraph`, before config write. Cold clone + env build for `git+https://…` takes 10–25s; the MCP handshake timeout is ~10s, so an unwarned first agent start would almost certainly fail.

- If `git` enabled and NOT `--no-deps` and NOT `dryRun`: run `uvx mcp-server-git --help` (bounded, stdout ignored, cache-only).
- If `astGrep` enabled and NOT `--no-deps` and NOT `dryRun`: run `uvx --from git+https://github.com/ast-grep/ast-grep-mcp ast-grep-server --help`.
- Child-process call carries an explicit timeout of `60_000` ms so a hung `git clone` never blocks the installer forever; expiry maps to `failed` with a bounded single-line `reason` via existing `failureReason()`.
- Extend `InstallResult.dependencies` from 2 to 4 keys (`codebaseMemory`, `memoryGraph`, `git`, `astGrep`) with statuses: `installed` = warmup passed, `skipped` = flag off or `--no-deps`/`dryRun`, `failed` = warmup error with `reason`. Unlike `codebase-memory` (where `failed` blocks the MCP write as a dead command), here `failed` STILL writes the config — the `uvx …` command stays valid and retries at runtime. Warmup is best-effort optimization, not a gate.
- `uv` dependency: reuse `ensureUv()` only as a `uvx` presence check. If `uvx` is absent, warmup = `failed` with hint to install uv (https://docs.astral.sh/uv/); config is still written. No silent auto-install of `uv` outside `provisionMemoryGraph` to avoid changing behavior for users who disabled `memorygraph`.

### 1.4 CLI output

In `main()`, add two lines next to the existing `Codebase Memory: …` / `MemoryGraph: …` via the same `dependencyLine()` formatter:

```text
Git: <status>
ast-grep: <status>
```

Explicitly out of scope for this section: `doctor` (Section 4), permissions (Section 2), prompts (Section 3). `--force` applies to the new keys exactly as for existing ones.

## Section 2/5 — Permissions: `lead.ts`, `workers.ts`, `editor.ts`, hard deny list

### 2.1 `orch-lead` (`src/agents/lead.ts`)

Behavior change, recorded explicitly:

- Before: `bash: "ask"`, allowed `context7_*`, `codebase-memory_*` (3 spellings), `memorygraph_*`.
- After: `bash: "allow"` (autonomous loop must not trip on confirmation dialogs at every step; safety is covered by the deny list + system prompt) plus `git_*`, `ast-grep_*`, `ast_grep_*` (both spellings, mirroring the three `codebase-memory` keys — guards against hyphen/underscore normalization differences between servers and the OpenCode engine).
- Hard block (verbatim list) if `RuntimeAgentConfig["permission"]` supports the object form `bash: { deny: [...] }`:

```ts
bash: {
  deny: [
    "rm -rf*",
    "rm -r*",
    "git reset --hard*",
    "git clean -f*",
    "git push*--force*",
    "git push*-f*",
    "mkfs*",
    "dd *",
    ">:*",
  ],
}
```

Fallback: if `@opencode-ai/plugin` types accept only `"allow" | "ask" | "deny"` for `bash`, keep `bash: "allow"` and enforce the list as prompt prohibitions; record the fallback in implementation notes. Verification step `npm run typecheck` decides which branch ships.

### 2.2 `orch-repo` (`src/agents/workers.ts`, `READ_ONLY`)

No `bash` (unchanged). Add `ast-grep_*` + `ast_grep_*` (pattern search without noise) and `git_*` (history: `git_log`, `git_diff` to answer «why is this workaround here»). Read-only at permission level if the engine supports per-tool granularity: `git_commit`/`git_add`/`git_reset` → `"deny"`, remaining `git_*` → `"allow"`; if the ast-grep server exposes a mutating rewrite tool, `deny` it for repo while allowing search tools. If per-tool deny is unavailable, allow `git_*` wholesale and enforce mutation bans via `repo.md` prompt only (Section 3), recorded as a limitation. `task: "deny"`, `external_directory: "ask"` unchanged.

### 2.3 `orch-editor` (`src/agents/editor.ts`)

Add `ast-grep_*` + `ast_grep_*` (`allow`) — the core value is multi-file AST-valid rewrites inside its own worktree. NO `bash` and NO `git_*` for editor: it commits through the internal worktree flow, not MCP (avoids competition with the integrator). The `bash` deny list does not apply (no `bash`).

### 2.4 `orch-integrator`, `orch-tests`

No new MCPs by decision. Integrator stays on the internal `worktree-adapter` (deterministic merge ordering, fail-closed on ownership/ancestry/conflict, worktrees retained). Tests stay `bash: allow` with no new MCPs and inherit the shared `bash` deny guard from 2.1 plus log-truncation prompt rules (Section 3), keeping the role focused on running tests and reading traces.

### 2.5 Tool-name normalization

Allow both hyphen and underscore spellings for the new servers (`git_*`, `ast-grep_*`, `ast_grep_*`), consistent with the existing triple for Codebase Memory. An extra harmless prefix costs nothing; a missing one breaks calls.

## Section 3/5 — Prompts: verbatim inserts with anchors

Existing texts are kept; sections are appended (so `lead.ts` `basePrompt` composition is unaffected).

### 3.1 `prompts/lead.md` — append `Tool Usage & Safety Protocols` after line 31

```markdown
## Tool Selection & Operational Protocols

### 1. Tool Routing: Codebase Memory vs ast-grep
- **Use `codebase-memory_*` for architectural topology:** finding symbol declarations, mapping caller/callee hierarchies, tracing imports, and determining blast radius across files.
- **Use `ast-grep_*` for syntactic matching and structural refactoring:** locating specific code forms (e.g., empty `catch` blocks, function calls missing required arguments, untyped returns) and performing multi-node AST rewrites.
- **Rule:** Never use `ast-grep` to guess dependency graphs; never use `codebase-memory` to find AST code patterns.

### 2. Bash Execution & Context Economy
- **Destructive Commands Prohibited:** `rm -rf`, `git reset --hard`, and `git push --force` are strictly forbidden. Use safer alternatives (move to trash, soft reset, standard push).
- **Mandatory Output Truncation:** Large terminal dumps flood the context window and will degrade execution quality. Always use quiet flags and truncate logs:
  - Add quiet flags when available: `pytest -q`, `npm test -- --silent`, `cargo test -q`.
  - Pipe verbose outputs through truncation tools: `<command> | head -n 50` or `<command> | tail -n 50`.
  - Never dump full dependency trees, raw binaries, or unpaginated log files into stdout.

### 3. Verification Precedence & Commit Gating
- **Commit Guard:** You are strictly forbidden from calling `git_commit` (or delegating final commits) until verification passes.
- **Enforcement Flow:** Changes must produce a green test suite and clean linter exit code (`exit 0`) via `orch-tests` or local test execution BEFORE any commit is registered.
```

Mirrors the Section 2 deny list at logic level (hardware guard + instruction).

### 3.2 `prompts/repo.md` — append `Search Tooling Protocol` (return format unchanged)

```markdown
## Search Tooling Protocol
- Use `codebase-memory_*` exclusively for symbol lookups, caller graphs, and understanding project architecture.
- Use `ast-grep_*` exclusively for finding exact syntactic patterns, code shapes, and anti-patterns.
- Read-only Git access: You may inspect history via `git_log` or `git_diff` to explain legacy decisions. Never invoke mutation operations (`git_commit`, `git_add`, `git_reset`).
```

### 3.3 `prompts/tests.md` — append `Execution Constraints`

```markdown
## Command Constraints & Log Budget
- You are solely responsible for verification: run tests, typecheckers, and linters.
- Large stdout outputs are prohibited. Always invoke runners in compact mode (`pytest -q`, `npm test -- --reporter=dot`, `cargo test -- -q`).
- If an error occurs, print only the failing assertions and relevant stack trace. Do not re-run full verbose suites without filtering.
```

### 3.4 `prompts/editor.md` — append `Editing Protocols` (approved tail, no `bash` mention)

```markdown
## Structural Changes via ast-grep
- Use `ast-grep_*` when making systematic, multi-file syntactic transformations to guarantee AST validity.
- Do not use `ast-grep` for arbitrary text replacement in non-code files (YAML, JSON, Markdown); use standard file reading and patch editing tools instead.
```

The «`rg` for YAML/Dockerfile/logs» rule lives only in `lead.md` (§2) and `orch-tests` practice, both of which own `bash`. It is deliberately absent here.

## Section 4/5 — Diagnostics and status: `doctor.ts`, `plugin-status.ts`, dashboard

### 4.1 `src/diagnostics/doctor.ts` — strictly offline and instant

- Extend `known` from `["context7", "codebase-memory", "memorygraph"]` with `["git", "ast-grep"]` so the generic `collectLocalMcps()` loop picks up the new local entries (`command not found` → `warning`, resolution via `probeStatus(cmd, ["--version"])`, no network).
- Three targeted toolchain checks, all via existing `resolveExecutable`/`probeStatus` (PATH probes only, never `uvx … --help` here):
  - `id: "git", label: "Git"` — candidates `["git"]`, args `["--version"]`; `ok` if found else `warning` with hint `Install git or ensure it is in PATH; Git MCP requires it.`
  - `id: "uvx", label: "uvx"` — candidates `["uvx", "~/.local/bin/uvx", "~/.cargo/bin/uvx"]` via the `localBinCandidates` pattern; `ok` if found else `warning` with hint `Install uv (astral.sh/uv); uvx runs Git and ast-grep MCP servers.`
  - `id: "ast-grep", label: "ast-grep engine"` — candidates `["ast-grep", "sg", "~/.local/bin/ast-grep", "~/.local/bin/sg"]`; `ok` if found else `info` (not `warning` — the server may ship built-in bindings while the system binary only speeds up Tree-Sitter; mirrors `codebase-memory` `info`-when-absent) with hint `Install ast-grep (ast-grep.github.io) for local Tree-Sitter parsing; MCP server still starts without it.`
- No network or cache rebuild in `doctor` — preserves instant CLI response on unstable connections.

### 4.2 `src/plugin-status.ts` — `detectMcpPresence()`

Add two keys keeping the existing camelCase style (`codebaseMemory`, `memoryGraph`):

```ts
git: "git" in mcp,
astGrep: "ast-grep" in mcp,
```

`formatPluginStatus()` needs no code change (generic `Object.entries(...).sort()` renders the new rows automatically). In `src/tools.ts`, update only the human-readable `orchestra_plugin_status` description from `(Context7, Codebase Memory, MemoryGraph, Playwright)` to include `Git` and `ast-grep`.

### 4.3 Dashboard (`src/dashboard/server.ts`, `mcpStatus` helper)

Same key set as 4.2 (`git`, `astGrep`), same main-config source, same «configured / not configured» chip style. No deletion or overwrite of user entries.

## Section 5/5 — Tests, README, examples, spec process

### 5.1 Tests (extend existing files; all mocks, no network)

- `test/cli.test.js`: defaults `git=true`/`astGrep=true`; `--no-git`/`--no-ast-grep` suppress `mcp.git`/`mcp.ast-grep`; keys are exactly `git`/`ast-grep` with Section 1 commands; warmup invoked with `60_000` timeout; `--no-deps` and `dryRun` skip warmup; `failed` warmup still writes config plus bounded `reason`; `--force` overwrites, otherwise `preserved`.
- `test/doctor.test.js`: `known` includes new names; missing `git`/`uvx` → `warning`, missing `ast-grep`/`sg` → `info`; present binaries → `ok`; assert no network calls (only `probeStatus --version`).
- `test/agents.test.js` (plus `plugin.test.js` permission cases where present): lead carries `git_*` + `ast-grep_*`/`ast_grep_*` with `bash: allow` plus deny list (or recorded fallback); repo carries new prefixes without `bash`; editor carries `ast-grep_*` without `bash`/`git_*`; integrator and tests unchanged.
- `test/plugin-status.test.js`: `detectMcpPresence()` maps `git`/`ast-grep` config keys to `git`/`astGrep` presence flags.
- Gate: full `npm run check` (typecheck + `npm test`) green. The `permission.bash` object-form support is decided by `npm run typecheck` against the installed `@opencode-ai/plugin` types.

### 5.2 README + examples (no JSON-schema change)

`schema/opencode-orchestra.schema.json` is untouched — MCP keys live in host `opencode.json`, not `orchestra.jsonc`:

- README: add Git + ast-grep to the one-command install list; document `--no-git`/`--no-ast-grep` alongside existing flags; add a companion-MCP subsection (Git: official `uvx mcp-server-git` without `--repository`, cwd + `repo_path`; ast-grep: `uvx --from git+…`, warmup rationale for the 10–25s cold start); extend the dashboard-status list; update any `--help` quote if present.
- Examples: `examples/opencode.jsonc` shows both new `mcp` blocks next to the existing ones as a working copy-paste reference.

### 5.3 Spec process (this file)

After chat approval of Section 5: write this single spec file, run the self-review below, commit ONLY the spec file, present the path for written-spec review, and wait before invoking `writing-plans`.

## Risks and explicit non-goals

- Engine permission granularity (Section 2 fallback) is the main compatibility risk; contained by the typecheck gate and prompt-level enforcement.
- `uvx --from git+https://…` warmup needs one-time network at install; runtime cold start without warmup risks the 10s handshake timeout — mitigated by Section 1.3, not eliminated for users who skip install.
- Non-goals: no Terminal MCP; no Ripgrep MCP (`rg` via `bash`); no `schema` change; no external `git_*` for `orch-integrator`; no `bash` for `orch-repo`/`orch-editor`; no network in `doctor`.

## Verification (design-level)

- `npm run check` green after implementation.
- Manual: fresh `install` writes `mcp.git`/`mcp.ast-grep`, warms cache within 60s each, `doctor` responds instantly offline, `/plugin-status` and dashboard list both servers, lead can call `git_status`/`ast-grep` search in a scratch project, and a commit attempt before green tests is refused per the Commit Guard.

## Spec self-review

1. **Placeholder scan:** no TBD/TODO; all commands, keys, flags, timeouts, statuses, and prompt blocks are literal. Warmup commands, `60_000`/`30_000` timeouts, `warning`/`info` levels, and file anchors are pinned.
2. **Internal consistency:** Section 1 warmup-failure-still-writes matches the autonomous-runtime rationale; Section 2 `lead.bash allow` matches the deny-guard compensation; editor has `ast-grep` but no `bash` in both matrix (Sec. 2.3) and prompt tail (Sec. 3.4); `doctor` offline rule (Sec. 4.1) does not contradict installer warmup (Sec. 1.3) — different commands, different contexts; schema untouched (Sec. 5.2) matches MCP keys living in host config.
3. **Scope check:** single implementation plan (build → permissions → prompts → diagnostics → tests/docs). No unrelated refactoring; dashboard change is presence-only.
4. **Ambiguity check:** «official Git MCP» means `uvx mcp-server-git`; «ast-grep server» means the exact `--from git+https://github.com/ast-grep/ast-grep-mcp ast-grep-server` argv; `repo_path` is dynamic per call with cwd fallback, never baked at install; `astGrep` (camelCase, code) vs `ast-grep` (kebab-case, config key) distinguished throughout.
