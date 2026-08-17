# OpenCode Orchestra 1.0.0

OpenCode Orchestra 1.0.0 is the first stable release of the model-routing and specialist-agent orchestration plugin for OpenCode. It combines automatic model discovery, profile-aware worker planning, budget controls, local diagnostics, usage telemetry, and a token-protected dashboard in one installable package.

## Highlights

### Stable orchestration contract

- One public `orch-lead`, a focused set of hidden specialist workers, and `orch-judge` for arbitration.
- Dependency-aware task plans and profile classification for architecture, debugging, UI, research, review, security, performance, migration, and operations work.
- Four distinct budget modes: `eco`, `balanced`, `quality`, and the maximum-throughput `ebobo` mode.
- Automatic discovery of models from connected OpenCode providers, with manual pools and per-agent overrides always taking precedence.

### Cost-aware routing

- Built-in offline model-price snapshot.
- Optional self-hosted price endpoint and periodic refresh.
- Explicit `priceInput` and `priceOutput` overrides for manual model entries.
- Informational pre-run estimates and configurable spend warnings in `orchestra_route`.
- Ordered cheaper fallback candidates exposed as resolver metadata for execution layers that implement retries.

> Orchestra does not intercept OpenCode provider requests and does not automatically retry failed provider calls.

### Local dashboard and telemetry

- Token, cost, model, agent, activity, projection, anomaly, and MCP status views.
- Authenticated CSV/JSON report export.
- Atomic, schema-validated configuration updates with backups and JSONC comment preservation.
- Prompt and reply storage is disabled by default and can only be enabled explicitly with `telemetry.storeTexts: true`.

### Operations and diagnostics

- `doctor` checks OpenCode configuration, Orchestra configuration, plugin registration, MCP entries, and local dependency paths.
- `update` checks npm for a newer release.
- `completion zsh|bash|pwsh` generates shell completions.
- `/plugin-status` reports the loaded plugin version, budget, model strategy, and companion MCP status.

## Install or upgrade

```bash
bunx @oeronteros-1/opencode-orchestra@latest install
```

The installer is idempotent, preserves existing plugin/MCP configuration, creates backups before changes, and updates bare or pinned Orchestra plugin entries to `@latest`.

To inspect proposed configuration changes without writing files:

```bash
bunx @oeronteros-1/opencode-orchestra@latest install --dry-run
```

After installation, restart OpenCode and run:

```text
/plugin-status
/orchestra-status
```

## Requirements

- OpenCode with plugin support compatible with `@opencode-ai/plugin >= 1.18.18`.
- Bun 1.2+ for the recommended installer command.
- Node.js 22+ for Node-based development and runtime tooling.

## Upgrade notes

- No configuration migration is required from 0.5.x.
- Existing OpenCode configuration, plugin options, and MCP entries are preserved.
- Use `--force` only to replace matching MCP entries with Orchestra defaults.
- Text telemetry remains opt-in and is disabled by default.
- The `pricing` section is now correctly represented in the published JSON Schema.

## Validation

This release was validated with:

- TypeScript checks for plugin and dashboard.
- 67 automated tests covering routing, pricing, telemetry, diagnostics, dashboard, installer, and integration paths.
- Production builds for the plugin and dashboard.
- npm package dry-run inspection.

## Full changelog

See [CHANGELOG.md](https://github.com/Oeronteros/opencode-orchestra/blob/v1.0.0/CHANGELOG.md).
