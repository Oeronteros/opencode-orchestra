# Git + ast-grep MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire official Git MCP and ast-grep MCP into installer, agent permissions, prompts, doctor, status, dashboard, docs, and tests.

**Architecture:** Extend existing companion-MCP patterns in place (no new files except tests already present); `uvx` warmup is best-effort with 60s timeout and never blocks config; permission granularity falls back to prompt-only because `RuntimeAgentConfig` allows only `allow|ask|deny`.

**Tech Stack:** TypeScript, OpenCode plugin API (`@opencode-ai/plugin`), `uvx`, node:test

**Spec:** `docs/superpowers/specs/2026-09-06-git-ast-grep-mcp-design.md`

## Global Constraints

- MCP config keys are kebab-case: `git`, `ast-grep` (timeout 30000, `enabled: true`).
- Git command is exactly `["uvx", "mcp-server-git"]` with no `--repository` flag.
- ast-grep command is exactly `["uvx", "--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"]`.
- Warmup child processes carry explicit 60000 ms timeout; warmup `failed` still writes config.
- `doctor` is strictly offline (PATH probes only, no network).
- `schema/opencode-orchestra.schema.json` is untouched (MCP keys live in host `opencode.json`).
- `orch-integrator` gets no external `git_*`; `orch-tests` unchanged; `prompts/editor.md` never mentions `bash`.
- Every change keeps `npm run check` green.

---

### Task 1: CLI installer (flags, config, warmup)

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: existing `InstallOptions`, `addMcp()`, `failureReason()`, `ensureUv()`, `spawnWithCmdFallback()`
- Produces: `options.git: boolean`, `options.astGrep: boolean`, `dependencies.git`, `dependencies.astGrep`, warmup with 60s timeout

- [ ] **Step 1: Write failing test for flags and MCP keys**

```ts
// test/cli.test.ts — add case: default install writes mcp.git and mcp.ast-grep
// with exact commands, and --no-git/--no-ast-grep suppress them.
```

Run: `npm test -- --test-name-pattern="git ast-grep installer"`
Expected: FAIL (options/keys do not exist)

- [ ] **Step 2: Extend InstallOptions + parseArguments + usage**

```ts
export interface InstallOptions {
  // ...existing...
  git: boolean
  astGrep: boolean
}
// defaults true; --no-git sets git=false; --no-ast-grep sets astGrep=false
// usage() gains two lines under Install options
```

- [ ] **Step 3: Add addMcp writes + warmup with 60s timeout**

```ts
if (options.git) addMcp("git", { type: "local", command: ["uvx", "mcp-server-git"], enabled: true, timeout: 30_000 })
if (options.astGrep) addMcp("ast-grep", { type: "local", command: ["uvx", "--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"], enabled: true, timeout: 30_000 })
// warmup (skip on dryRun/--no-deps): spawnWithCmdFallback with timeout 60_000
// uvx mcp-server-git --help ; uvx --from git+https://github.com/ast-grep/ast-grep-mcp ast-grep-server --help
// failed warmup -> { status: "failed", reason } but config still written
```

- [ ] **Step 4: Run CLI tests**

Run: `npx tsc -p tsconfig.test.json && node --test dist-test/test/cli.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: add git and ast-grep MCP installer with uvx warmup"
```

### Task 2: Agent permissions (fallback documented)

**Files:**
- Modify: `src/agents/lead.ts`, `src/agents/workers.ts`, `src/agents/editor.ts`
- Test: `test/agents.test.ts`

**Interfaces:**
- Consumes: `RuntimeAgentConfig` (`Record<string, PermissionAction | Record<string, PermissionAction>>`, only `allow|ask|deny`)
- Produces: lead `bash: allow` + new prefixes; repo/editor extended; integrator/tests unchanged

- [ ] **Step 1: Write failing test for new prefixes**

```ts
// test/agents.test.ts — lead permission has git_*, ast-grep_*, ast_grep_*;
// repo has ast-grep_*/git_* without bash; editor has ast-grep_*.
```

Run: `node --test dist-test/test/agents.test.js`
Expected: FAIL

- [ ] **Step 2: Implement (prompt-enforced deny; NO bash object-form)**

```ts
// lead.ts: bash: "allow" (was "ask") + "git_*": "allow", "ast-grep_*": "allow", "ast_grep_*": "allow"
// + code comment: granular bash deny patterns (rm -rf*, git reset --hard*, push --force, ...)
//   are NOT emittable — RuntimeAgentConfig allows only allow|ask|deny; enforced via prompts (Task 3).
// workers.ts READ_ONLY + orch-repo: add "git_*", "ast-grep_*", "ast_grep_*" (no bash).
// editor.ts: keep existing bash: "allow" (scoped verification needs it; spec matrix deviation recorded),
//   add "ast-grep_*": "allow", "ast_grep_*": "allow". No git_*.
```

- [ ] **Step 3: Run agents tests + typecheck**

Run: `npx tsc -p tsconfig.build.json && node --test dist-test/test/agents.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agents/lead.ts src/agents/workers.ts src/agents/editor.ts test/agents.test.ts
git commit -m "feat: wire git and ast-grep tools to lead, repo, and editor"
```

### Task 3: Prompts (verbatim inserts)

**Files:**
- Modify: `prompts/lead.md`, `prompts/repo.md`, `prompts/tests.md`, `prompts/editor.md`

**Interfaces:**
- Consumes: spec Section 3 blocks
- Produces: appended sections at documented anchors; editor tail without bash mention

- [ ] **Step 1: Append four blocks verbatim (lead §1-3, repo protocol, tests constraints, editor structural)**

Exact texts from spec Section 3.1–3.4 (editor tail ends with «use standard file reading and patch editing tools instead.»).

- [ ] **Step 2: Verify prompts load**

Run: `node --test dist-test/test/plugin.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add prompts/lead.md prompts/repo.md prompts/tests.md prompts/editor.md
git commit -m "docs: add git and ast-grep tool routing and safety prompts"
```

### Task 4: Diagnostics and status

**Files:**
- Modify: `src/diagnostics/doctor.ts`, `src/plugin-status.ts`, `src/dashboard/server.ts`, `src/tools.ts`
- Test: `test/doctor.test.ts`, `test/plugin-status.test.ts`, `test/dashboard.test.ts`

**Interfaces:**
- Consumes: `collectLocalMcps()`, `resolveExecutable()`, `detectMcpPresence()`, `mcpStatus()`
- Produces: offline git/uvx warning + ast-grep info; presence keys `git`/`astGrep`; tool description updated

- [ ] **Step 1: Write failing doctor/status tests**

```ts
// doctor: known includes git/ast-grep; missing git/uvx -> warning; missing ast-grep/sg -> info
// plugin-status: "git" in mcp -> git:true; "ast-grep" in mcp -> astGrep:true
```

Run: `node --test dist-test/test/doctor.test.js dist-test/test/plugin-status.test.js`
Expected: FAIL

- [ ] **Step 2: Implement**

```ts
// doctor.ts: known Set += git, ast-grep; checks git/uvx (warning) + ast-grep engine (info), PATH probes only
// plugin-status.ts: return { ..., git: "git" in mcp, astGrep: "ast-grep" in mcp }
// dashboard/server.ts mcpStatus(): same two keys
// tools.ts: orchestra_plugin_status description += Git, ast-grep
```

- [ ] **Step 3: Run diagnostics tests**

Run: `node --test dist-test/test/doctor.test.js dist-test/test/plugin-status.test.js dist-test/test/dashboard.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/diagnostics/doctor.ts src/plugin-status.ts src/dashboard/server.ts src/tools.ts test/doctor.test.ts test/plugin-status.test.ts test/dashboard.test.ts
git commit -m "feat: diagnose and report git and ast-grep MCP presence offline"
```

### Task 5: Docs, examples, full gate

**Files:**
- Modify: `README.md`, `examples/opencode.jsonc`
- Test: full `npm run check`

**Interfaces:**
- Consumes: all prior tasks
- Produces: install list + flags + companion-MCP paragraphs + dashboard list; working example blocks; green gate

- [ ] **Step 1: Update README install list, flags, companion section, dashboard list**

- [ ] **Step 2: Update examples/opencode.jsonc with both mcp blocks**

```jsonc
"mcp": {
  "git": { "type": "local", "command": ["uvx", "mcp-server-git"], "enabled": true, "timeout": 30000 },
  "ast-grep": { "type": "local", "command": ["uvx", "--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"], "enabled": true, "timeout": 30000 }
}
```

- [ ] **Step 3: Run full gate**

Run: `npm run check`
Expected: PASS (typecheck + all node --test files)

- [ ] **Step 4: Commit**

```bash
git add README.md examples/opencode.jsonc
git commit -m "docs: document git and ast-grep MCP setup"
```
