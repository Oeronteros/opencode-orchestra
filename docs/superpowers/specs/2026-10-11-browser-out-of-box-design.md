# Browser MCPs out of the box

Status: design approved in conversation; written specification awaiting review.

## Intent and agreed outcome

After installing Orchestra, users can use both Playwright MCP and Chrome DevTools MCP without manually configuring MCP commands or browser paths. Use an installed system Chrome first; automatically download official Chrome for Testing (CfT) when Chrome is absent. The user selected this fallback strategy and approved provisioning during `install`, with a retry on first browser use after transient installation failures.

Success means a fresh supported installation can run a real browser scenario through both MCPs, sharing one managed Chrome and persistent Orchestra profile. Installing npm packages or displaying configured servers alone is insufficient evidence of success.

## Current implementation and gaps

- `src/config/schema.ts` defaults missing `browser.mode` to `off`. `profiles` is an array of names, with `["default"]` as its default (not an object).
- `src/cli.ts` scaffolds `auto` only for new configurations and preserves existing `orchestra.jsonc` wholesale.
- `src/browser/manager.ts` searches fixed executable paths and fails with `browser_chrome_missing`; it has no downloader.
- `src/browser/packages.ts` resolves pinned MCP packages and genuine Node. Both MCPs already support attaching to the manager's CDP endpoint.
- `src/browser/v2.ts` registers servers dynamically after preparation. Its tool transform also wraps recognized user-managed servers and rejects their execution; this interference must be removed as part of browser compatibility.
- Runtime access uses sealed scenario contracts. Automatic provisioning must integrate with that execution path and its native tool registration.
- Earlier local logs showed rejected Orchestra tool schemas. End-to-end acceptance must verify that the browser control and routing tools actually register on the supported host; installing Chrome cannot remedy missing control tools.

## Configuration and migration

1. The effective default for omitted `browser.mode` becomes `auto`, including plugin-only loading without running the installer. Explicit `off`, `playwright`, and `devtools` retain their meanings.
2. The installer adds missing browser defaults to existing JSONC using targeted edits and a backup. Preserve comments, model settings, profiles, executable overrides, and explicit browser modes.
3. An explicit `--browser-mode` sets the requested mode; `--no-playwright` alone sets `off`, including reinstallations. `--no-playwright --browser-mode devtools` remains valid; combinations with `auto` or `playwright` remain errors. Without an explicit CLI choice, preserve an explicit stored mode, including `off`.
4. Normal project/global configuration precedence remains intact. Installation modifies only the selected configuration directory; a project-level explicit `off` remains authoritative for that project.
5. Add `browser.download: boolean`, default `true`, to allow use of existing browsers without network provisioning when false.
6. `--dry-run` performs no download or configuration writes. `--no-deps` skips installation-time provisioning; runtime download remains governed by `browser.download`. Document this distinction.

Minimal configuration (normally unnecessary):

```json
{
  "browser": {
    "mode": "auto",
    "profile": "default",
    "profiles": ["default"],
    "download": true
  }
}
```

## Browser resolution and provisioning

Resolution order:

1. An explicit absolute `browser.executable`: validate and use it. An invalid explicit path produces an actionable error rather than silently selecting another browser.
2. An installed system Chrome, using platform installation locations and appropriate executable discovery.
3. A complete, validated managed CfT installation in the user cache.
4. If downloads are enabled, download CfT from Google's official distribution and validate the result.

Separate offline discovery from `ensureBrowser`, which may provision. `browser status` and doctor call discovery only. `install`, browser login/restart, and the first authorized runtime preparation call the provisioning path as needed. Plugin import/config transforms do not block on a browser download or launch Chrome.

The installer checks the selected mode and Node prerequisite before provisioning, displays progress, and records a browser dependency result. A failed browser preparation reports a warning while allowing core Orchestra installation. First browser use retries a prior transient failure once per preparation, within a bounded time budget; there is no continuous background retry.

Use a maintained browser installation library with an explicit dependency for official CfT platform resolution and archive handling; do not depend on another package's private/transitive installer APIs. Confirm its current API and package requirements during implementation planning. Resolve an exact Stable build from the official manifest on the first download and store its build ID. Reuse that build on later runs without querying the network on every launch. Automatic background upgrades are outside this change.

Managed root:

- Windows: `%LOCALAPPDATA%\\opencode-orchestra\\chrome-for-testing`.
- macOS: `~/Library/Application Support/opencode-orchestra/chrome-for-testing`.
- Linux: `$XDG_DATA_HOME/opencode-orchestra/chrome-for-testing`, falling back to `~/.local/share/opencode-orchestra/chrome-for-testing`.

Metadata records platform, architecture, exact build, executable-relative path, and completed installation state. Store the resolved path in runtime metadata, not `browser.executable`, so later system Chrome discovery still has priority.

Downloads use a bounded timeout (10 minutes), cancellation, temporary staging, and a per-cache cross-process lock. Only a completed extraction with the expected executable is published atomically. A concurrent caller rechecks the completed cache after acquiring the lock. Failure or cancellation cleans up only that attempt's staging data and releases its lock. Interrupted partial data is never treated as installed.

Validate HTTP results, archive completion and expected executable layout; use publisher digests when actually provided, without claiming unavailable checksum guarantees. Paths read from metadata must stay under the managed root. Binaries are separate from persistent browser profiles.

## Platform support

Select a download only when the official CfT catalog supplies a compatible platform/architecture. Initial acceptance covers Windows x64, macOS x64/arm64, and Linux x64 with Chrome runtime libraries. Unsupported combinations receive a precise diagnostic and can still use an explicitly configured compatible system browser. Do not map Linux ARM64 to an x64 archive or promise native CfT availability without catalog evidence.

Linux shared-library and display requirements are checked through actual launch validation and reported clearly. Automatic OS package-manager installation requiring elevated privileges is outside this change. Headless configurations remain supported.

## Runtime and MCP lifecycle

Keep one managed Chrome per owning runtime/profile. Both backends attach to its verified loopback CDP endpoint. OpenCode owns MCP transport lifecycle.

In `auto`, both managed backend registrations are prepared against that endpoint on first authorized browser preparation. A selected single-backend mode prepares only that backend. Startup failures are recorded per backend: when one backend is sufficient for the requested scenario it may operate in a clearly reported degraded state; a task requiring the failed backend must fail explicitly. Never report both connected based solely on package presence.

No Chrome window opens merely from importing the plugin or installing configuration. Browser tools become executable through the existing preparation/scenario flow. Native `orchestra_browser` and required routing tools must be visible and callable on the supported OpenCode version. Validate native schema registration with the real host, addressing compatibility failures that block this flow.

Recognized user-managed browser MCPs remain user-managed: do not overwrite their configuration, wrap their executors, or reject their direct calls. Report any duplicate managed-backend conflict explicitly. Reserved-name conflicts cannot silently replace a user's server.

Existing profile ownership, scenario serialization, permissions, artifact handling, backend handoff, and shutdown rules continue to govern execution. Provisioning does not create a separate personal Chrome profile or start one browser per MCP.

## Diagnostics and failure semantics

Expose separate fields for effective mode, browser source (`configured`, `system`, `managed`, or `missing`), executable/build, provisioning status, Node availability, package availability, and per-backend connection/error state. Use `not started` for a lazy backend rather than conflating it with `disabled`.

Errors distinguish invalid explicit paths, unavailable Node/host capabilities, unsupported platform, download failure/timeout, extraction failure, insufficient storage, launch failure, profile contention, conflicting user MCP, and individual MCP handshake failure. Include a concrete recovery action and preserve the underlying useful error detail. Installation may complete with a browser warning; only successful live checks warrant a ready/connected claim.

## Verification and acceptance

- Fresh installation without Chrome provisions CfT and defaults to `auto`.
- A valid system Chrome or explicit override avoids downloading; an invalid explicit override produces a specific error.
- Existing config lacking browser mode becomes enabled; explicit `off` survives a default reinstall. Explicit CLI mode choices work consistently.
- JSONC comments and unrelated settings survive migration, with a backup.
- Cache reuse is offline and idempotent; two concurrent installers cannot publish a partial browser.
- Cancellation, interrupted archives, HTTP errors, unsupported architectures, and disabled downloads produce testable recovery behavior.
- Status, doctor, and dry-run never download or launch a browser.
- An installed package, rather than only source-tree imports, resolves both pinned MCP binaries under real Node (including a Bun-hosted plugin).
- Real OpenCode loads the browser control and routing tools without schema-registration errors.
- A temporary test profile and local fixture verify Playwright navigation/snapshot and DevTools inspection against the same browser; graceful restart retains fixture cookies/localStorage.
- Backend failure is reported accurately and does not falsely claim both servers connected; user-managed MCP calls remain usable.
- Type checks and applicable regression tests pass. A platform or live check not actually exercised is explicitly recorded as unverified.

## Delivery scope

Update installer/config/schema, add a focused browser provisioning module, integrate manager/runtime/native host, and update CLI/doctor/plugin status. Update English, Russian and Chinese README browser guidance, `docs/browser.md`, examples, and the browser verification report. Add meaningful provisioning/migration/native integration tests and packaged live smoke coverage.

Publishing to npm and changing the user's running service are separate from implementing and verifying this repository change. No release is implied by approving this specification.

## Workflow checklist

- [x] Inspect existing configuration, installer, browser manager, package resolver, and native MCP host.
- [x] Agree on system Chrome with automatic CfT fallback and installation-time provisioning.
- [x] Write this specification and review it for contradictions, missing requirements, and scope.
- [ ] User reviews and approves this written specification.
- [ ] Create the implementation plan and select its execution method.
- [ ] Implement and verify the approved plan.
