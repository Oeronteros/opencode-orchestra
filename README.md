# OpenCode Orchestra

[![npm version](https://img.shields.io/npm/v/@oeronteros-1/opencode-orchestra)](https://www.npmjs.com/package/@oeronteros-1/opencode-orchestra)
[![license](https://img.shields.io/npm/l/@oeronteros-1/opencode-orchestra)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-4f46e5)](https://opencode.ai/docs/plugins/)

**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

OpenCode Orchestra turns a complex request into a controlled multi-agent workflow. It classifies the task, chooses connected models, dispatches focused specialists, merges their evidence, applies changes, verifies the result, and records local cost and usage telemetry.

- One primary agent with a team of focused, permission-scoped specialists
- Automatic model discovery, budget modes, per-agent overrides, and fallback chains
- Dependency-aware execution with hard concurrency, depth, and ownership limits
- Optional isolated Git worktrees for parallel editors
- Local dashboard for live activity, tokens, cost, models, agents, and MCP health
- Diagnostics, MCP smoke tests, bounded autonomous loops, and offline voice input

## Quick start

Requirements: [OpenCode](https://opencode.ai/), Bun 1.2 or newer, and a supported OpenCode model provider.

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

Restart OpenCode, then run:

```text
/orchestra Find the cause of the intermittent login failure, fix it, and run the relevant tests
```

Useful status commands:

```text
/orchestra-status
/plugin-status
```

The installer is idempotent. It backs up the OpenCode configuration before changing it and preserves existing plugins and MCP entries unless `--force` is explicitly supplied.

## Dashboard

The dashboard is local, token-protected, and bound to `127.0.0.1` by default. It shows live agent activity, usage trends, model and agent breakdowns, estimated or provider-reported cost, MCP health, anomalies, and exportable reports.

```bash
bunx @oeronteros-1/opencode-orchestra@latest dashboard
```

![OpenCode Orchestra dashboard overview](docs/assets/dashboard-overview.png)

![OpenCode Orchestra agent workload dashboard](docs/assets/dashboard-agents.png)

Prompts and replies are not persisted unless `telemetry.storeTexts` is explicitly enabled.

## How it works

```text
request
  → task classification and capability analysis
  → sealed dependency-aware plan with TaskContracts
  → parallel evidence workers, subject to shared limits
  → one provenance-preserving merge
  → optional judge for critical risk or unresolved disagreement
  → implementation, integration, and aggregate verification
  → local telemetry and cost accounting
```

In `ebobo` mode, tasks classified as research use a bounded research swarm. With the default eight-node limit, four workers explore independent hypotheses, two second-round workers receive every first-round result and reallocate their effort toward the strongest surviving directions, `orch-merge` consolidates the shared hypothesis ledger, and `orch-judge` independently verifies the candidate result. Mathematical proofs, conjectures, scientific hypotheses, failed approaches, counterexamples, and reusable intermediate results are carried between rounds with node provenance. A provisional or unresolved judge verdict is not treated as completion.

`orch-lead` is the public primary agent. It can edit the current workspace, run verification, and coordinate the rest of the team. Internal workers are hidden from normal agent completion by default and have narrower permissions.

| Agent | Role | Writes files |
|---|---|---:|
| `orch-lead` | Planning, coordination, implementation, and final verification | Yes |
| `orch-repo` | Repository structure, Git history, dependencies, and blast radius | No |
| `orch-docs` | Official documentation and upstream source | No |
| `orch-tests` | Reproduction paths, test coverage, and verification commands | No |
| `orch-research` | Standards, implementations, and ecosystem research | No |
| `orch-critic` | Independent review and assumption checking | No |
| `orch-security` | Trust boundaries, authorization, secrets, and data handling | No |
| `orch-visual-reference` | UI references, interaction patterns, and motion | No |
| `orch-visual-generate` | Exploratory visual generation | Generated assets only |
| `orch-visual-review` | Screenshot, hierarchy, accessibility, and regression review | No |
| `orch-editor` | Isolated implementation in an assigned worktree | Assigned scope only |
| `orch-integrator` | Deterministic, fail-closed integration of validated commits | Git integration only |
| `orch-merge` | Evidence synthesis with provenance and uncertainty | No |
| `orch-judge` | Arbitration for critical risk or unresolved disagreement | No |

### Execution guards

- `parallelWorkers` is the hard tree-wide concurrency limit.
- `maxWorkers` limits unique worker nodes across the entire task tree.
- `maxDelegationDepth` limits nested delegation.
- Every dispatched node receives a sealed TaskContract with its goal, inputs, completion criteria, allowed paths, exclusive resources, and delegation budget.
- Independent nodes that claim the same mutable resource are serialized.
- A failed dependency blocks downstream nodes instead of allowing partial execution to drift.

The default limits are eight workers, eight concurrent workers, and a delegation depth of two. Limits are enforced by the runtime, not only by prompts.

## Installation

The default installer configures the Orchestra plugin and attempts to provision its companion tools:

- [Superpowers](https://github.com/obra/superpowers) skills
- [Context7](https://github.com/upstash/context7) for current library documentation
- [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) for repository indexing and impact analysis
- [MemoryGraph](https://github.com/memory-graph/memory-graph) for durable decisions and reusable knowledge
- the official Git MCP, restricted to the active repository
- ast-grep MCP for structural code search
- Playwright MCP for browser inspection
- the local voice overlay and Whisper model on supported platforms

Provisioning failures for optional companions do not prevent the core plugin from being configured. Dead local MCP commands are not written when provisioning fails.

Common installation options:

```text
--no-context7
--no-codebase-memory
--no-memorygraph
--no-git
--no-ast-grep
--no-playwright
--no-superpowers
--no-voice
--no-deps
--dry-run
--force
--config-dir DIR
```

Inspect changes without writing files or downloading dependencies:

```bash
bunx @oeronteros-1/opencode-orchestra@latest install --dry-run
```

## Model routing

The default `auto` strategy discovers models exposed by connected OpenCode providers and derives their relevant capabilities, including tools, reasoning, vision, image output, and context size. Auto-discovery fills only empty pools and never overwrites a non-empty manual pool.

If discovery is temporarily unavailable, Orchestra leaves the agent model unset so OpenCode can preserve the user's current model.

### Budget modes

| Mode | Routing policy |
|---|---|
| `eco` | Prefer free models and restrict premium escalation |
| `balanced` | Prefer subscription/free models with limited premium escalation |
| `quality` | Prefer stronger lead models and allow paid candidates |
| `ebobo` | Use the bounded research swarm for research tasks, prefer frontier arbitration, and always consult the judge |

Budget modes affect model choice, paid-call limits, and escalation. They do not increase the runtime's worker limits.

### Per-agent models and fallback

```jsonc
{
  "$schema": "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
  "budget": "balanced",
  "models": {
    "strategy": "auto",
    "agents": {
      "orch-lead": "provider/primary-model",
      "orch-repo": "provider/code-model",
      "orch-judge": "provider/frontier-model"
    },
    "fallback": {
      "enabled": true,
      "maxRetries": 2,
      "agents": {
        "orch-repo": ["provider/backup-one", "provider/backup-two"]
      }
    }
  }
}
```

An exact `models.agents` override has the highest priority. Retryable failures such as rate limits, timeouts, and provider 5xx errors may advance to the next compatible model. Authentication, permission, and invalid-request failures stop the chain.

Runtime fallback is performed directly for evidence, review, merge, and judge subagents. The primary lead and workspace-aware editor/integrator calls remain on OpenCode's native dispatch path.

## Parallel editing

Parallel editors are experimental and disabled by default:

```jsonc
{
  "orchestration": {
    "parallelEditors": 3,
    "worktreeRoot": ".orchestra/worktrees"
  }
}
```

Each editor receives non-overlapping path ownership and an isolated Git worktree. Before integration, Orchestra validates the actual commit diff, ancestry, and ownership boundaries. The integrator builds a deterministic conflict map and integrates all validated commits or none of them.

On an ownership violation, ancestry failure, or Git conflict, integration fails closed and keeps the worktrees for diagnosis. The lead must still run aggregate verification after a successful integration.

## Bounded Loop

Bounded Loop lets `orch-lead` continue a single goal over multiple controlled iterations. It is opt-in:

```jsonc
{
  "orchestration": {
    "loop": {
      "enabled": true,
      "maxIterations": 10,
      "maxMinutes": 30,
      "noProgressLimit": 3
    }
  }
}
```

```text
/loop Fix the failing tests
/loop --file docs/plan.md
/loop status
/loop stop
```

Only an unquoted final `MORE: <remaining work>` line authorizes another iteration. `DONE: <summary>` records the agent's completion claim; it is not an independent verification result. Permission requests and unknown replies pause the loop, while errors and new user messages stop it.

Loop state is in memory and is lost when OpenCode restarts. A non-empty `verifyCommand` currently fails closed because permission-safe runtime shell verification is not supported; ask the lead to run verification through its normal tools.

## Voice input

The standard installer provisions a prebuilt local voice overlay for Linux x64 and Windows x64 and downloads the `ggml-base.bin` Whisper model. No audio is sent to a remote transcription service.

For the terminal UI, start:

```bash
voice-overlay
```

For OpenCode Web, run OpenCode and the local voice proxy in separate terminals:

```bash
opencode web --port 4096
bunx @oeronteros-1/opencode-orchestra@latest web
```

Then open `http://127.0.0.1:4097`. The microphone button is added next to the prompt submit button and inserts recognized text into the draft without sending it.

See [voice-overlay/README.md](voice-overlay/README.md) for platform requirements and troubleshooting.

## Configuration

Global configuration:

```text
~/.config/opencode/orchestra.jsonc
```

Project configuration:

```text
<project>/.opencode/orchestra.jsonc
```

Project values override global values; explicit plugin options override both. `OPENCODE_CONFIG_DIR` and `--config-dir` are supported.

A practical starting configuration:

```jsonc
{
  "$schema": "https://unpkg.com/@oeronteros-1/opencode-orchestra@latest/schema/opencode-orchestra.schema.json",
  "budget": "balanced",
  "models": {
    "strategy": "auto",
    "agents": {},
    "fallback": { "enabled": true, "maxRetries": 2, "agents": {} }
  },
  "orchestration": {
    "parallelWorkers": 8,
    "maxWorkers": 8,
    "maxDelegationDepth": 2,
    "parallelEditors": 0,
    "exposeWorkers": false
  },
  "permissions": { "autoAcceptAll": false },
  "telemetry": {
    "enabled": true,
    "directory": ".orchestra",
    "storeTexts": false
  },
  "pricing": {
    "estimate": true,
    "warnThresholdUSD": 0.5,
    "openrouter": { "enabled": false, "ttlHours": 12 }
  }
}
```

The complete contract and bounds are defined in [schema/opencode-orchestra.schema.json](schema/opencode-orchestra.schema.json). A larger example is available in [examples/.opencode/orchestra.jsonc](examples/.opencode/orchestra.jsonc).

`permissions.autoAcceptAll` approves every OpenCode permission prompt while enabled. It is disabled by default and should be used only in a trusted workspace.

## CLI reference

| Command | Purpose |
|---|---|
| `install` | Configure OpenCode and provision companion MCPs |
| `dashboard` | Start the local telemetry dashboard |
| `voice-web`, `web` | Proxy OpenCode Web with an inline offline microphone |
| `doctor` | Diagnose configuration, MCPs, and local toolchain paths |
| `mcp-smoke` | Launch enabled local MCPs and test `initialize`, `tools/list`, and safe calls |
| `update` | Check npm for a newer release |
| `completion` | Print completion for `zsh`, `bash`, or `pwsh` |

Examples:

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor --json
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory . --json
bunx @oeronteros-1/opencode-orchestra@latest update
bunx @oeronteros-1/opencode-orchestra@latest completion pwsh
```

`doctor` is offline and non-destructive. `mcp-smoke` starts configured local MCP processes and performs a real protocol handshake; remote and disabled entries are reported as skipped.

## Pricing and telemetry

Orchestra resolves prices in this order:

1. an explicit price on the configured model candidate;
2. provider-supplied pricing;
3. the bundled price snapshot or a configured private endpoint;
4. the optional public OpenRouter catalog fallback.

Unknown prices remain unknown and are never silently treated as free. Subscription candidates are tracked separately from free and paid candidates.

The local ledger records tokens, cost, model and agent identifiers, MCP success and latency aggregates, routing decisions, and sanitized reliability events. Raw MCP arguments and output are not stored. Prompt and response text storage is opt-in.

## Safety and privacy

- Dashboard and voice services bind to loopback by default.
- Dashboard URLs contain a random access token.
- Telemetry is stored locally under `.orchestra` by default.
- Message text is not persisted unless `telemetry.storeTexts: true`.
- Reliability events do not retain raw provider errors.
- Read-only workers cannot edit files and cannot use native unguarded delegation.
- The official Git MCP is restricted to the active repository.
- Dangerous Git reset operations are denied; mutating operations require the relevant agent permission.
- Invalid Orchestra configuration degrades to safe defaults without overwriting the invalid file.

## Requirements and development

- Bun 1.2+ for the recommended installer flow
- Node.js 22+ for development and Node-based tooling
- Python 3.10+ only when provisioning the PyPI MemoryGraph companion
- Git for worktree-based parallel editing and the Git MCP

```bash
npm ci
npm run check
npm run test:mcp-live
npm run build
npm pack --dry-run
```

The regular test suite is self-contained. `test:mcp-live` launches configured external MCP tools and is intended for an environment where those companions are installed.

## Troubleshooting

Start with:

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor
```

If a local MCP is configured but cannot start, run:

```bash
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory .
```

Use `--json` for machine-readable diagnostics. On Windows, Orchestra resolves `.exe`, `.cmd`, and `.bat` shims and uses a safe `cmd.exe` fallback only where required.

## License

[MIT](LICENSE)
