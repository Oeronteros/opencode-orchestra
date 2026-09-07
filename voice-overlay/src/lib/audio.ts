export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const MAX_SECONDS = 120;
/** ~0.5 s of 16 kHz mono s16le; smaller wav files count as empty. */
export const MIN_WAV_BYTES = 16000;

export type OsKind = "linux" | "win32";

const DSHOW_AUDIO_LINE = /"([^"]+)"\s*\(audio\)/g;

export function parseDshowDevices(ffmpegStderr: string): string[] {
  const out: string[] = [];
  for (const m of ffmpegStderr.matchAll(DSHOW_AUDIO_LINE)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

export function ffmpegInputArgs(os: OsKind, device: string | undefined): string[] {
  if (os === "linux") return ["-f", "pulse", "-i", device ?? "default"];
  if (device !== undefined) return ["-f", "dshow", "-i", `audio=${device}`];
  return ["-f", "wasapi", "-i", "default"];
}

export function ffmpegOutputArgs(wavPath: string): string[] {
  return ["-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-c:a", "pcm_s16le", "-y", wavPath];
}
