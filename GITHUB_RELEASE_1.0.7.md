# OpenCode Orchestra 1.0.7

Patch release focused on robust OpenCode integration and cross-runtime setup.

## Highlights

- Added a stable `opencode-orchestra` plugin module ID while retaining compatible named server exports.
- Added explicit package entrypoint and TypeScript export metadata.
- Made the packaged CLI executable with Node.js while preserving Bun compatibility.
- Improved config discovery precedence: global config, preferred project JSONC config, then plugin options.
- Added a timeout and graceful fallback for connected-model discovery.
- Made optional Codebase Memory and MemoryGraph provisioning best-effort so failures do not block plugin setup.
- Removed unconditional initializer stderr output.
- Added regression coverage for entrypoint identity and config discovery.

## Validation

- TypeScript typecheck passed.
- 70 tests passed.
- Dashboard and plugin production builds passed.
- `node dist/cli.js --help` smoke test passed.
