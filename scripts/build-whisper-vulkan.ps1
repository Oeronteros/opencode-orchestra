# Build whisper.cpp with the Vulkan backend and install it for voice-overlay.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-whisper-vulkan.ps1 [-Version b4938]
param(
  [string]$Version = "b4938",
  [string]$Destination = "$env:LOCALAPPDATA\Programs\voice-overlay\vulkan",
  [string]$BuildDir = "$env:TEMP\whisper-vulkan-build"
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  throw "cmake not found. Install it with: winget install Kitware.CMake"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git not found. Install Git for Windows."
}
if (-not $env:VULKAN_SDK) {
  throw "VULKAN_SDK is not set. Install the Vulkan SDK (it provides glslc, required by GGML_VULKAN)."
}

New-Item -ItemType Directory -Force $BuildDir | Out-Null
if (-not (Test-Path (Join-Path $BuildDir "whisper.cpp\.git"))) {
  git clone --branch $Version --depth 1 https://github.com/ggml-org/whisper.cpp (Join-Path $BuildDir "whisper.cpp")
}

Push-Location (Join-Path $BuildDir "whisper.cpp")
try {
  cmake -B build -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
  cmake --build build --config Release --target whisper-server --parallel
  $server = Get-ChildItem build -Recurse -Filter whisper-server.exe | Select-Object -First 1
  if (-not $server) { throw "whisper-server.exe was not produced by the build." }
  New-Item -ItemType Directory -Force $Destination | Out-Null
  Copy-Item $server.FullName $Destination -Force
  # Shared builds also produce runtime DLLs that must sit next to the exe.
  Get-ChildItem build -Recurse -Filter *.dll | ForEach-Object { Copy-Item $_.FullName $Destination -Force }
  Write-Host "Vulkan build ready: $Destination"
  Write-Host "Activate it with: opencode-orchestra voice-accelerator vulkan"
} finally {
  Pop-Location
}
