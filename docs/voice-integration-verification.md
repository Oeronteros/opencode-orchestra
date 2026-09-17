# Voice integration: implementation and verification

## Result

The embedded Web microphone inserts transcription into the current OpenCode composer.
It never lists sessions or calls the session prompt API. Insert is the default;
InsertAndSubmit clicks the ordinary Send control after another route/editor check.
A changed route retains a recoverable, editable transcript instead of inserting it
into the newly selected session. Recovery never automatically submits.

Desktop Auto preserves the existing TUI append endpoint. Explicit Web destination
retains the session picker and preview. `/voice`, absent in the original checkout,
is now a fallback page using the existing browser recording/STT implementation and
the proxied session API. The proxy remains loopback-only.

## Changed components

- `src/voice-context.ts`: invocation types, destination policy, validated defaults and legacy config migration.
- `src/voice-opencode-adapter.ts`: semantic composer/send selectors, native editing, idempotent mounting and guarded submit.
- `src/voice-web-client.ts`: browser settings, invocation snapshots, remote picker, recovery UI and recording lifecycle.
- `src/voice-web.ts`: serialized client dependencies, `/voice`, selected STT model allowlist and privacy-safe errors.
- `voice-overlay/src/{App.tsx,settings.tsx,api.ts}`: Auto/Insert defaults, advanced connection settings, optional submission and encoded session IDs.
- `voice-overlay/src-tauri/src/main.rs`: authenticated TUI submit command and HTTP acknowledgement test; Rust formatting.
- `voice-overlay/src-tauri/src/sidecars.rs`: formatting and test-only helper annotation for strict Clippy.
- `voice-overlay/src-tauri/Cargo.lock`: Cargo updated tokio-macros to the version required by the resolved Tokio dependency.
- `voice-overlay/src-tauri/.gitignore`: generated schemas and downloaded sidecars excluded.
- `test/voice-web.test.ts`, `test/fixtures/voice-browser.ts`: policy, migration, lifecycle, remote, recovery and submission tests.
- `scripts/voice-browser-smoke.mjs`: reproducible real-browser editing/event smoke fixture without microphone/LLM calls.
- `voice-overlay/README.md`: flows, configuration, compatibility and verification instructions.

## Configuration

Existing overlay storage key and connection/device/model/session fields remain.
`target` gains `auto` (new default); legacy `tui` and `web` persist, and `destination`
is accepted as an alias when `target` is absent. New `postTranscriptionAction` is
`insert` by default or `insert-and-submit`. Invalid fields fall back safely.
Browser settings are separate, because Tauri and browsers have distinct device IDs
and storage origins. Browser settings persist under `orchestra-voice-settings:v1`.

## Evidence collected

- Full project check: 415 passing tests, no failures; root TypeScript checks passed.
- Later focused Web suite: 24 passing tests, including config normalization, persistence, new-session draftId isolation, microphone errors and cancellation of late STT responses.
- Overlay TypeScript tests: 23 passing tests; overlay typecheck and frontend build passed.
- Root dashboard/plugin build passed; existing dashboard chunk-size warning remains.
- Rust tests in WSL/Linux: 12 passed, including a local authenticated submit endpoint fixture.
- Strict Linux Clippy (`cargo clippy --locked --all-targets -- -D warnings`) passed after fixing a needless borrow and marking the PulseAudio test helper test-only.
- Linux `cargo build --locked` completed successfully (debug executable).
- Prettier and rustfmt run; `git diff --check` passed.
- Real-browser fixture: input event state received the Russian acceptance phrase;
  Insert kept submit count at zero; persisted InsertAndSubmit produced one submit;
  rerender retained one microphone; A→B during STT preserved recovery text and left B empty.
- Remote browser page: session list loaded and selected session survived reload.
- Actual OpenCode 1.18.19 through the proxy: microphone mounted beside Send; voice settings showed microphone/model/action only, with no destination/session picker. Its new-session route exposed a query-based draftId; the adapter now includes the query in its captured context and a regression test covers switching drafts.
- Live OpenCode 1.18.19 TUI on a separate loopback port: `/tui/append-prompt` returned true and the terminal rendered the control text in its input, with no submission.
- Actual installed Whisper/base in WSL completed a PCM WAV probe through `transcribeWebAudio`; this checks executable/model availability and processing, not speech accuracy.
- Actual upstream source was inspected for the semantic composer/send attributes and onInput handling:
  https://github.com/anomalyco/opencode/blob/dev/packages/app/src/components/prompt-input.tsx

## Remaining verification and constraints

Real microphone → Whisper → actual OpenCode end-to-end acceptance is not yet proven
by the deterministic browser fixture. Windows native packaging is not covered by
Linux cargo checks. The adapter still depends on OpenCode semantic DOM attributes
and browser support for native `execCommand('insertText')` editing.

TUI's append endpoint addresses the active server input and cannot prove a specific
terminal session remained active. The existing mechanism is retained as requested.
`/voice` does not imply a new public/LAN listener; phone access requires an appropriate
secure tunnel and browser secure context. Small-model download remains manual.

Next release gate: real microphone E2E on the supported OpenCode version and native
Windows packaging, with repeated session navigation and an agent already running.
