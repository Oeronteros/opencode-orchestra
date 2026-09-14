#!/usr/bin/env bash
# Minimal Linux recorder. Generic static FFmpeg downloads omit PulseAudio.
# Usage: build-voice-ffmpeg.sh <extracted FFmpeg source> <output binary>
set -euo pipefail
source_dir=$(realpath "$1")
output=$(realpath -m "$2")
cd "$source_dir"
./configure \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-shared --enable-static --disable-x86asm \
  --disable-ffplay --disable-ffprobe --enable-ffmpeg \
  --enable-libpulse --enable-indev=pulse,lavfi \
  --enable-decoder=pcm_s16le,pcm_f32le --enable-encoder=pcm_s16le \
  --enable-filter=aresample,aformat,anull,sine \
  --enable-muxer=wav --enable-protocol=file,pipe
make -j"$(nproc)"
./ffmpeg -hide_banner -devices 2>&1 | grep -E 'D.*pulse'
./ffmpeg -hide_banner -f lavfi -i 'sine=frequency=440:duration=1' \
  -ar 16000 -ac 1 -c:a pcm_s16le -y voice-probe.wav
test "$(stat -c %s voice-probe.wav)" -gt 32000
install -m 755 ffmpeg "$output"
