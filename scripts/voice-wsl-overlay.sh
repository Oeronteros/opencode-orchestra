#!/usr/bin/env bash
set -euo pipefail

# Use the reviewable local Windows build when running this checkout from WSL.
# Published CLI installations discover the managed Windows companion themselves.
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_binary="$task_root/.cache/voice-widget-build/voice-overlay.exe"
if [[ -z "${ORCHESTRA_VOICE_WINDOWS_BINARY:-}" && -f "$task_binary" ]]; then
  export ORCHESTRA_VOICE_WINDOWS_BINARY="$task_binary"
fi
if [[ ! -f "$task_root/dist/cli.js" ]]; then
  printf '%s\n' 'Build the CLI first: npm run build:plugin' >&2
  exit 1
fi
exec node "$task_root/dist/cli.js" voice-overlay
