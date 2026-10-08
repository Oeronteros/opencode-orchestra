# OpenCode Orchestra

[![npm version](https://img.shields.io/npm/v/@oeronteros-1/opencode-orchestra)](https://www.npmjs.com/package/@oeronteros-1/opencode-orchestra)
[![license](https://img.shields.io/npm/l/@oeronteros-1/opencode-orchestra)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-4f46e5)](https://opencode.ai/docs/plugins/)

**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

OpenCode Orchestra turns a complex request into a controlled multi-agent workflow. It classifies the task, chooses connected models, dispatches focused specialists, merges their evidence, applies changes, verifies the result, and records local cost and usage telemetry.

**OpenCode Orchestra targets OpenCode v2** and loads through its plugin `setup` API. A compatibility entrypoint remains available for OpenCode 1.18.29 and newer.

- One primary agent with a team of focused, permission-scoped specialists
- Automatic model discovery, budget modes, per-agent overrides, and fallback chains
- Dependency-aware execution with hard concurrency, depth, and ownership limits
- Optional isolated Git worktrees for parallel editors
- Managed Chrome with persistent profiles, Playwright for UI workflows, and DevTools for diagnostics
- Local dashboard for live activity, tokens, cost, models, agents, and MCP health
- Diagnostics, MCP smoke tests, bounded autonomous loops, and offline voice input

## Quick start

Requirements: [OpenCode v2](https://opencode.ai/), Bun 1.2 or newer, Node.js 22.12 or newer, and a supported OpenCode model provider. Managed browsing additionally requires OpenCode 2.0.16 or newer and a separately installed Chrome.

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
/orchestra-resume
```

The installer is idempotent. It backs up the OpenCode configuration before changing it and preserves existing plugins and MCP entries. `--force` replaces companion MCP entries managed by the installer; existing browser MCP entries and `orchestra.jsonc` are preserved. New configurations enable managed browsing with `browser.mode: "auto"`; existing configurations without a browser section keep it off.

### OpenCode v2 support and migration

For OpenCode v2, the plugin loads through the `setup` API. The installer seeds Orchestra agent names in the OpenCode config because v2 plugins can update existing agents but cannot create them through an agent transform. After upgrading from OpenCode 1.x, run `install` again. The legacy entrypoint remains available for OpenCode 1.18.29 and newer. OpenCode v2 normalizes supported v1 config fields at load time, so a config rewrite is optional. See the [official migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

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

### Resume after restart

Orchestra stores the sealed plan, node states, dependency results, and validated Git commits locally in `.orchestra/orchestration/runs.json`. After a restart, active and queued repository nodes become pending; completed nodes are not run again. Interrupted browser nodes become blocked and require site-state inspection before an explicit retry, so external mutations are not automatically repeated.

```text
/orchestra-resume
/orchestra-resume <original-session-id>
```

With no argument, the newest unfinished run is resumed. Persistence can be disabled or moved:

```jsonc
{
  "orchestration": {
    "persistence": {
      "enabled": true,
      "directory": ".orchestra/orchestration"
    }
  }
}
```

The state file is local but contains worker results. Protect its directory like the repository when those results may contain sensitive data.

Each checkpoint has one writer, identified by a process ID and a unique lease in `runs.json.lock`. A second plugin instance reports a conflict and cannot overwrite the owner's state or consume dashboard actions. Normal disposal releases the lease; a lease left by a dead process is reclaimed on restart. Save failures appear immediately in the log and in `orchestra_plugin_status`; corrupt checkpoints remain untouched after restore fails. An invalid lock or an interrupted lock reclamation requires inspection before removing the lock and restarting the plugin.

OpenCode V2 event subscriptions reconnect with delays from 500 ms up to 30 seconds. On reconnect, Orchestra reconciles tracked sessions with their history, delivers only completed assistant responses, and restores terminal events from idle markers. Completed responses remain deduplicated beyond 2,048 messages.

### Verified completion

Before final checks, `orch-lead` registers exact commands and expected artifacts through `orchestration_set_verification`. Commands run through the normal `bash` tool, so OpenCode permissions still apply. The runtime marks a command gate as passed only after the matching call succeeds, and checks artifact existence directly inside the workspace.

`orchestration_complete` distinguishes working, claimed, failed, and verified completion. By default a run cannot become verified without at least one gate or while any plan node is unfinished or unsuccessful. This can be disabled with `orchestration.verification.required`; `orchestration.verification.maxGates` caps the number of gates.

### Per-task budget

In addition to the model-selection mode, you can set hard cost, token, and elapsed-time limits. A value of `0` disables that limit:

```jsonc
{
  "orchestration": {
    "taskBudget": {
      "maxCostUSD": 2,
      "maxTokens": 120000,
      "maxMinutes": 15,
      "unknownPricing": "warn"
    }
  }
}
```

Before execution, Orchestra estimates and reserves the whole DAG budget. A plan whose estimate already exceeds a limit is rejected. Between worker calls, the runtime checks actual cost and tokens from the local ledger; elapsed time starts with the run and survives restart. `unknownPricing: "block"` rejects or stops work when a price cannot be determined, while `"warn"` explicitly excludes unknown calls from the USD total. One call to `orchestra_route` can override these limits with `maxCostUSD`, `maxTokens`, and `maxMinutes`.

### Execution graph and adaptive teams

`ebobo` retains its full bounded team for maximum-quality arbitration; the minimal initial team applies to the other budget modes.

The dashboard **Runs** page renders the persisted dependency graph, node contracts, outputs, failures, completion gates, and task budget. A running branch can be cancelled and a failed, blocked, or cancelled branch can be retried. Retry invalidates downstream results and stale worker responses cannot overwrite the new attempt.

While a node is pending or active, the lead can send a bounded clarification through `orchestration_relay_context`. The update survives restart and retry, and an active dispatch asks the same worker session for a revised complete result before marking the node successful.

By default Orchestra starts with two specialists plus synthesis and keeps the remaining worker slots available. `orchestration_adapt` can add a versioned branch only for a concrete runtime trigger such as a failed reproduction, contradictory evidence, an authorization boundary, a documentation gap, a performance or visual regression, low confidence, or evidence-backed lack of progress. Every trigger needs evidence, repeated triggers are ignored, and the dashboard shows the resulting plan version. Configure this with `orchestration.adaptive.initialWorkers`, `maxExtensions`, and `minEvidenceItems`.

Loop progress uses successful nodes, validated commits, and passed verification gates. Rephrasing the same `MORE` reason no longer resets the no-progress limit.

### Built-in evaluations

`opencode-orchestra eval --json` emits the versioned five-case core suite and structural routing coverage for solo, eco, balanced, quality, and ebobo modes. Supply observed rows with `--results results.json` to compare success rate, elapsed time, USD cost, and tokens. `--write baseline.json` stores a report; a later `--baseline baseline.json` exits with status 2 when success falls by more than five percentage points or mean time/cost rises by more than 20%.

### Verified reusable knowledge

After `orchestration_complete` returns verified completion, `orchestra_knowledge_record` can store a decision, exact test command, or constraint with evidence, source run, plan version, Git revision, and affected paths. `orchestra_route` and `orchestra_knowledge_query` reuse valid entries. An entry becomes stale when it expires, its paths have uncommitted changes, or those paths changed after its source revision; stale entries are returned only as leads. The local store defaults to `.orchestra/knowledge/verified.json` and is bounded by `orchestration.knowledge.maxEntries`.

## Installation

The default installer configures the Orchestra plugin and attempts to provision its companion tools:

- [Superpowers](https://github.com/obra/superpowers) skills
- [Context7](https://github.com/upstash/context7) for current library documentation
- [Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) for repository indexing and impact analysis
- [MemoryGraph](https://github.com/memory-graph/memory-graph) for durable decisions and reusable knowledge
- the official Git MCP, restricted to the active repository
- the [GitHub MCP server](https://github.com/github/github-mcp-server) for remote repositories, issues, and pull requests
- ast-grep MCP for structural code search
- pinned Playwright MCP and Chrome DevTools MCP packages for managed browsing
- the local voice overlay and Whisper model on supported platforms

Provisioning failures for optional companions do not prevent the core plugin from being configured. Failed Codebase Memory or MemoryGraph provisioning does not write a dead local command. Git and ast-grep entries can still be configured after a failed warmup because `uvx` retries when they launch. Browser MCPs are package dependencies, registered lazily by the OpenCode v2 runtime; Chrome itself is not downloaded by the installer.

To connect GitHub MCP once, install [GitHub CLI](https://cli.github.com/) and enter this command **inside OpenCode**:

```text
/github-connect
```

The command opens GitHub CLI browser sign-in if needed, then stores the token in `~/.config/opencode-orchestra/github-token` and points OpenCode to that file. The token file contains the credential in plain text and is created with owner-only permissions on Unix. Restart OpenCode afterward. You can also set `GITHUB_PERSONAL_ACCESS_TOKEN` in OpenCode's environment without running this command. The token needs access to the repositories and operations you want to use.

Common installation options:

```text
--no-context7
--no-github
--no-codebase-memory
--no-memorygraph
--no-git
--no-ast-grep
--no-playwright
--browser-mode MODE
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

`--browser-mode` accepts `off`, `auto`, `playwright`, or `devtools` and only affects a newly created Orchestra configuration. `--no-playwright` scaffolds `off`; combine it with `--browser-mode devtools` for DevTools only. Combining it with `auto` or `playwright` is an error. `--no-deps` skips companion provisioning but does not remove the browser MCP dependencies from the npm package.

## Managed browser

Orchestra uses its own Chrome profiles without a browser extension. In `auto` mode, UI navigation and forms prefer Playwright; deep diagnostics and performance use Chrome DevTools. Both backends attach to the same managed browser. Ordinary documentation research continues to use web search, webfetch, and Context7.

For an existing installation, add this to global or project `orchestra.jsonc` to enable browsing:

```jsonc
{
  "browser": {
    "mode": "auto",
    "profile": "default",
    "profiles": ["default", "work-account"],
    "sharedProfiles": [],
    "headless": false
  }
}
```

Restart OpenCode after editing the configuration. Run these commands from the project directory:

```bash
bunx @oeronteros-1/opencode-orchestra@latest browser status --directory .
bunx @oeronteros-1/opencode-orchestra@latest browser login --directory . --profile default
bunx @oeronteros-1/opencode-orchestra@latest browser profiles --directory .
bunx @oeronteros-1/opencode-orchestra@latest browser select --directory . --profile work-account
```

Sign in directly in the Chrome window opened by `browser login`, then close Chrome or press Ctrl+C before using that profile in OpenCode. Cookies and localStorage persist across browser restarts; sites may still expire authentication. Profiles are scoped to the repository, with Git worktrees sharing its identity. Account names must be listed in `browser.profiles`; cross-project sharing requires an explicit `sharedProfiles` entry. `browser select` writes a project override that takes effect after restarting OpenCode.

Browser scenarios are serialized and require one page tab. Sealed task contracts limit origins and operations, and OpenCode permissions still apply. Existing user-managed browser MCPs block duplicate managed servers. Browser Code Mode is disabled. Missing Chrome or a busy profile produces a browser failure while repository orchestration remains available.

Use `browser.executable` for an absolute Chrome path and `browser.nodeExecutable` for real Node when OpenCode runs under Bun. See [docs/browser.md](docs/browser.md) for profile storage, permissions, backend handoff, artifacts, and troubleshooting.

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

Runtime fallback and lifecycle accounting are performed directly for every Orchestra subagent. Editor dispatch creates an isolated Git worktree from the sealed base revision; the integrator runs in the primary checkout only after every editor commit passes validation. The primary lead remains on OpenCode's native path.

Retryable failures apply an exponential delay starting at 500 ms and a provider cooldown shared by this plugin's workers. `Retry-After` accepts seconds or an HTTP date. A dispatch waits at most five seconds in total; models whose provider deadline exceeds that allowance are skipped so another provider in the configured chain can be tried. Cancellation interrupts the delay. Authentication and invalid-request failures remain terminal.

Auto-discovery treats absent, partial, or invalid catalog tariffs as potentially paid. These models have no fabricated zero price, are excluded when paid calls are disallowed, and log a warning under `unknownPricing: "warn"`. With `unknownPricing: "block"`, they are excluded from discovered pools. An explicitly zero input and output tariff still qualifies as free; configured manual pools and explicit subscription declarations retain their existing semantics.

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

Only an unquoted final `MORE: <remaining work>` line authorizes another iteration. When verification is required, `DONE: <summary>` completes the loop only after `orchestration_complete` succeeds; otherwise the loop becomes `unverified`. Permission requests and unknown replies pause the loop, while errors and new user messages stop it.

Bounded-loop state itself is in memory and is lost when OpenCode restarts. A non-empty `verifyCommand` still fails closed; safe verification runs through registered gates and OpenCode's normal permissioned tools.

## Voice input

For OpenCode 2 on Windows and Linux, launch `bunx @oeronteros-1/opencode-orchestra@latest voice-overlay` once, then focus the prompt in TUI, Desktop or any browser. **Ctrl+Alt+Space** starts recording; press it again to stop, transcribe locally and paste through the system clipboard. Send the prompt manually. No fixed server port or web proxy is required for this shortcut. Keep the same window, tab and input focused while dictating. A changed window, title or native focus retains the text for retry with the same shortcut; unsent text survives an overlay restart. The overlay can be minimized to the system tray while recording; its shortcut stays active and a left click on the tray icon restores the window. The Auto insert switch is on by default; turning it off keeps an editable result for explicit insertion with the same shortcut. Linux X11 requires xclip, EWMH and XTEST; terminals use Ctrl+Shift+V. The new Wayland backend supports GNOME through the bundled Shell extension, Plasma through portals and kdotool, and Sway/Hyprland through wl-clipboard, wtype and compositor IPC. It needs an updated Linux companion and [desktop setup](voice-overlay/linux/README.md); the source changes have not yet been published. When focus validation rejects a Wayland target, the editable text remains in the overlay.

The standard installer provisions local ffmpeg and Whisper binaries for Linux x64 and Windows x64 and downloads the `ggml-base.bin` model. No audio is sent to a remote transcription service.

All voice paths support Russian, English and Chinese with `base`, `small` or `large-v3-turbo-q5_0`. Install an additional model with `opencode-orchestra voice-model large-v3-turbo-q5_0` (about 547 MiB, verified with SHA-256), or substitute `small`. Select the model and speech language in the overlay or inline web microphone settings. `auto` detects the language of each recording; short or mixed-language recordings may work better with an explicit language.

Recognition runs through one long-lived `whisper-server` process (the model stays loaded between dictations), passes `-t` with the physical core count (`ORCHESTRA_VOICE_THREADS` overrides it), trims leading/trailing silence, and recognizes completed 30-second segments while you are still speaking on the overlay and `voice-tui` paths; the web microphone still sends the full recording. On Windows, `opencode-orchestra voice-accelerator cuda` (or `cuda11`) installs the pinned CUDA build; Vulkan is built locally with `scripts/build-whisper-vulkan.ps1`/`.sh` and enabled with `voice-accelerator vulkan`. See [voice-overlay/README.md](voice-overlay/README.md) for details.

For legacy **OpenCode 1.x** TUI sessions, run `bunx @oeronteros-1/opencode-orchestra@latest voice-tui`. Press **Ctrl+X, then E** or run `/editor`, speak, and press the same shortcut again (or Enter). OpenCode restores the transcript to that session's draft without submitting it. `Ctrl+C` cancels recording and preserves the draft. The launcher sets `EDITOR` and `VISUAL` for that OpenCode process; no separate window or fixed port is needed. Run plain `opencode` when you want a regular text editor.

For the external editor, set `ORCHESTRA_VOICE_MODEL=base|small|large-v3-turbo-q5_0` and `ORCHESTRA_VOICE_LANGUAGE=ru|en|zh|auto` (choose one value for each; defaults: `base`, `ru`), or `ORCHESTRA_VOICE_DEVICE` to select a microphone. The overlay and web microphone have their own saved settings. To use the old manual TUI window, select its TUI 1.x server compatibility mode:

```bash
opencode --port 4096
# in another terminal:
bunx @oeronteros-1/opencode-orchestra@latest voice-overlay
```

This launches the floating window on Windows/Linux without adding its directory to PATH. If it is not installed yet, the CLI provisions the platform package and prepares the `base` model.

For OpenCode Web, run OpenCode and the local voice proxy in separate terminals:

```bash
opencode web --port 4096
bunx @oeronteros-1/opencode-orchestra@latest web
```

Then open `http://127.0.0.1:4097`. The microphone button is added next to the prompt submit button and inserts recognized text into the draft by default. Its settings also offer explicit insert-and-send. If the session changes while recording or transcribing, the result stays in an editable recovery panel; restoring it never sends automatically.

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
  "browser": { "mode": "auto", "profile": "default", "profiles": ["default"] },
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
| `browser status`, `browser profiles` | Inspect managed browser requirements and configured profiles |
| `browser login`, `browser restart` | Open the selected profile in visible managed Chrome |
| `browser select` | Select a configured profile in project configuration |
| `browser reset --profile NAME --confirm NAME` | Delete an unlocked profile's authentication and site data |
| `voice-overlay` | Launch the offline voice overlay and global shortcut |
| `voice-model <name>` | Install a verified `base`, `small` or `large-v3-turbo-q5_0` model |
| `voice-accelerator [auto\|cpu\|cuda\|cuda11\|vulkan]` | Choose the local Whisper accelerator (CUDA/Vulkan) |
| `voice-tui [args]` | Launch legacy OpenCode 1.x with a voice editor |
| `voice-editor <file>` | Record into the draft file supplied by OpenCode `/editor` |
| `voice-web`, `web` | Proxy OpenCode Web with an inline offline microphone |
| `doctor` | Diagnose configuration, MCPs, and local toolchain paths |
| `mcp-smoke` | Launch enabled local MCPs and test `initialize`, `tools/list`, and safe calls |
| `eval` | Compare reproducible solo and Orchestra results and check a baseline |
| `update` | Check npm for a newer release |
| `completion` | Print completion for `zsh`, `bash`, or `pwsh` |

Examples:

```bash
bunx @oeronteros-1/opencode-orchestra@latest doctor --json
bunx @oeronteros-1/opencode-orchestra@latest mcp-smoke --directory . --json
bunx @oeronteros-1/opencode-orchestra@latest eval --results results.json --json
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
- Node.js 22.12+ for development and Node-based tooling
- OpenCode 2.0.16+ and separately installed Chrome for managed browsing
- Python 3.10+ only when provisioning the PyPI MemoryGraph companion
- Git for worktree-based parallel editing and the Git MCP

```bash
npm ci
npm run check
npm run build
npm pack --dry-run
```

The regular test suite is self-contained; live browser checks are skipped unless explicitly enabled. Optional integration checks:

```bash
npm run test:mcp-live
npm run test:browser-live
npm run test:browser-e2e
```

`test:mcp-live` launches external MCP tools and requires installed companions. `test:browser-live` uses a temporary test-only profile and local fixture; missing Chrome is reported as skipped. `test:browser-e2e` runs the repository's Playwright regression fixture. Set `ORCHESTRA_TEST_CHROME` to an absolute Chrome executable for either browser check, or explicitly install Playwright Chromium for E2E with `npx playwright install chromium`.

The voice overlay has a separate dependency install and checks:

```bash
npm --prefix voice-overlay ci
npm --prefix voice-overlay run typecheck
npm --prefix voice-overlay test
npm --prefix voice-overlay run build:frontend
```

Use `npm run dev:dashboard` for the dashboard. Native voice development (`npm run dev:voice`, `npm run build:voice`) additionally requires Rust, platform Tauri dependencies, and the voice sidecars described in [voice-overlay/README.md](voice-overlay/README.md).

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
