# Changelog

## 0.5.3 — 2026-08-19

- Export both `server` and `default` from the plugin entry so OpenCode 1.18.x (which resolves `PluginModule.server`) and older builds both load it.
- Write `@oeronteros-1/opencode-orchestra@latest` into `opencode.json` instead of a bare name so users track new releases.
- Upgrade existing bare/pinned plugin entries to `@latest` on install instead of leaving them stale.
- Add regression coverage for the `@latest` entry upgrade logic.

## 0.5.1 — 2026-08-17

- Record all OpenCode assistant responses in local telemetry, including the primary OpenCode mode.
- Preserve Orchestra-specific counters for free worker calls and judge escalations.
- Add regression coverage for telemetry updates outside `orch-*` modes.
