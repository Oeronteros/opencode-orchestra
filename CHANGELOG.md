# Changelog

All notable changes to OpenCode Orchestra are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-17

### Added

- Production-ready orchestration with a public `orch-lead`, specialist workers, `orch-judge`, dependency-aware task plans, profile classification, and four budget modes: `eco`, `balanced`, `quality`, and `ebobo`.
- Automatic discovery and capability scoring for models exposed by connected OpenCode providers, while preserving explicit per-agent and manual-pool overrides.
- Model pricing support with an offline snapshot, optional self-hosted refresh endpoint, explicit per-model price overrides, pre-run cost estimates, and configurable spend warnings.
- Ordered cheaper fallback metadata for execution layers that support retrying provider calls.
- Local telemetry dashboard with token, cost, model, agent, activity, monthly projection, anomaly, and MCP status views.
- Authenticated CSV and JSON exports for activity, models, agents, daily usage, and summary reports.
- Optional prompt/reply telemetry through `telemetry.storeTexts`; message text remains disabled by default.
- `opencode-orchestra doctor` for configuration, plugin, MCP, and local toolchain diagnostics, including JSON output.
- `opencode-orchestra update` for checking the latest published npm version.
- Shell completion generators for zsh, bash, and PowerShell.
- Plugin runtime status through `/plugin-status` and the `orchestra_plugin_status` tool.
- Cross-platform, idempotent installer for the Orchestra plugin, Context7, Codebase Memory, and MemoryGraph.
- JSON Schema for `orchestra.jsonc`, including pricing and opt-in text telemetry settings.
- Expanded regression and integration coverage across routing, pricing, telemetry, dashboard, diagnostics, installer, and plugin initialization.

### Changed

- Promoted the package to the stable `1.0.0` API and configuration contract.
- Hardened dashboard configuration writes with full-schema validation, empty agent-model normalization, JSONC comment preservation, backups, and atomic replacement.
- Improved paid-model estimation to honor explicit prices and each worker's actual capability.
- Bounded streaming text buffers and added plugin-disposal cleanup for timers and in-memory telemetry state.
- Clarified that fallback lists are resolver metadata; OpenCode provider calls are not intercepted or retried automatically by the plugin.
- Added npm repository, homepage, issue tracker, release keywords, and a pre-publish validation gate.

### Fixed

- Fixed the published JSON Schema so `pricing` is accepted as a configuration section.
- Fixed prompt telemetry correlation between user and assistant messages.
- Fixed stale pricing snapshots, concurrent refresh races, and unsafe passthrough of remote price fields.
- Fixed dashboard saves when optional per-agent model fields are left blank.
- Fixed invalid export parameters to return HTTP 400 instead of HTTP 500.
- Fixed monthly pace analytics so current-month projections use a prior-period baseline.

### Compatibility and upgrade notes

- Requires Node.js 22 or newer for Node-based development and runtime tooling.
- The recommended installer requires Bun 1.2 or newer.
- Existing bare or pinned plugin entries are upgraded to `@oeronteros-1/opencode-orchestra@latest` by the installer while preserving plugin options.
- Existing OpenCode and MCP configuration is preserved; use `--force` only when you explicitly want Orchestra's MCP defaults to replace matching entries.
- Text telemetry remains opt-in. Existing installations continue to record usage metadata without prompt or reply contents.

## [0.5.3] — 2026-08-17

### Fixed

- Exported both `server` and `default` from the plugin entry for OpenCode 1.18.x and older plugin loaders.
- Wrote `@oeronteros-1/opencode-orchestra@latest` into OpenCode configuration and upgraded existing bare or pinned entries.

## [0.5.1] — 2026-08-17

### Changed

- Recorded all OpenCode assistant responses in local telemetry, including primary OpenCode mode.
- Preserved Orchestra-specific counters for free worker calls and judge escalations.

[1.0.0]: https://github.com/Oeronteros/opencode-orchestra/compare/v0.5.3...v1.0.0
[0.5.3]: https://github.com/Oeronteros/opencode-orchestra/compare/v0.5.1...v0.5.3
[0.5.1]: https://github.com/Oeronteros/opencode-orchestra/releases/tag/v0.5.1
