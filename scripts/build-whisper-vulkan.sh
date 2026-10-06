#!/usr/bin/env bash
# Build whisper.cpp with the Vulkan backend and install it for voice-overlay.
# Usage: scripts/build-whisper-vulkan.sh [version] [destination]
set -euo pipefail

VERSION="${1:-b4938}"
DEST="${2:-$HOME/.local/bin/vulkan}"
BUILD="${BUILD_DIR:-$(mktemp -d)}"

command -v cmake >/dev/null || { echo "cmake is required" >&2; exit 1; }
command -v glslc >/dev/null || { echo "glslc is required (Vulkan SDK / shaderc); on Debian/Ubuntu: sudo apt install glslc" >&2; exit 1; }

git clone --branch "$VERSION" --depth 1 https://github.com/ggml-org/whisper.cpp "$BUILD/whisper.cpp"
cmake -S "$BUILD/whisper.cpp" -B "$BUILD/build" -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD/build" --config Release --target whisper-server --parallel "$(nproc)"

mkdir -p "$DEST"
find "$BUILD/build" -name 'whisper-server' -type f -exec cp {} "$DEST/" \;
find "$BUILD/build" -name 'lib*.so*' -type f -exec cp {} "$DEST/" \;
echo "Vulkan build ready: $DEST"
echo "Activate it with: opencode-orchestra voice-accelerator vulkan"
