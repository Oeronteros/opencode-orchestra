/**
 * Canonical 16 kHz mono PCM16 WAV helpers shared by the recorder and the web
 * proxy: silence trimming (energy VAD) and segment slicing for progressive
 * long-recording transcription.
 */
export const VOICE_WAV_HEADER_BYTES = 44
export const VOICE_SAMPLE_RATE = 16000
export const VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2

/** Byte length of one progressive transcription segment (whisper's 30 s window). */
export const VOICE_SEGMENT_SECONDS = 30
export const VOICE_SEGMENT_BYTES = VOICE_SEGMENT_SECONDS * VOICE_BYTES_PER_SECOND

export interface VoicePcmWav {
  dataStart: number
  dataBytes: number
}

/** Validates the canonical header written by ffmpeg with our fixed profile. */
export function parseVoiceWav(wav: Buffer): VoicePcmWav | null {
  if (wav.length < VOICE_WAV_HEADER_BYTES) return null
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  if (wav.toString('ascii', 12, 16) !== 'fmt ' || wav.readUInt32LE(16) !== 16) return null
  if (wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1) return null
  if (wav.readUInt32LE(24) !== VOICE_SAMPLE_RATE) return null
  if (wav.readUInt32LE(28) !== VOICE_BYTES_PER_SECOND) return null
  if (wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16) return null
  if (wav.toString('ascii', 36, 40) !== 'data') return null
  const declared = wav.readUInt32LE(40)
  const available = wav.length - VOICE_WAV_HEADER_BYTES
  const dataBytes = Math.min(declared, available) & ~1
  if (dataBytes <= 0) return null
  return { dataStart: VOICE_WAV_HEADER_BYTES, dataBytes }
}

export function wrapPcmAsWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(VOICE_WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(VOICE_SAMPLE_RATE, 24)
  header.writeUInt32LE(VOICE_BYTES_PER_SECOND, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Extracts an aligned byte range from a canonical WAV into a standalone WAV. */
export function sliceVoiceWav(wav: Buffer, startByte: number, endByte: number): Buffer {
  const parsed = parseVoiceWav(wav)
  if (parsed === null) return wav
  const start = Math.max(0, Math.min(startByte, parsed.dataBytes)) & ~1
  const end = Math.max(start, Math.min(endByte, parsed.dataBytes)) & ~1
  return wrapPcmAsWav(wav.subarray(parsed.dataStart + start, parsed.dataStart + end))
}

export interface TrimSilenceOptions {
  frameMs?: number
  padMs?: number
  /** Below this duration (ms) a "win" is ignored to avoid churn. */
  minTrimMs?: number
  /** Absolute RMS floor; lower values keep quiet microphones audible. */
  rmsFloor?: number
}

export interface TrimSilenceResult {
  wav: Buffer
  trimmed: boolean
  speechMs: number
  silenceMs: number
}

function frameRms(wav: Buffer, dataStart: number, frameStart: number, frameBytes: number): number {
  let sum = 0
  const samples = frameBytes >> 1
  for (let i = 0; i < samples; i++) {
    const sample = wav.readInt16LE(dataStart + frameStart + (i << 1)) / 32768
    sum += sample * sample
  }
  return samples === 0 ? 0 : Math.sqrt(sum / samples)
}

/**
 * Trims leading/trailing near-silence with an adaptive noise floor (10th
 * percentile of frame RMS). Returns the original buffer when no meaningful
 * win is available, so callers can safely always pass audio through it.
 */
export function trimVoiceSilence(wav: Buffer, options: TrimSilenceOptions = {}): TrimSilenceResult {
  const parsed = parseVoiceWav(wav)
  const unchanged = (speechMs = 0, silenceMs = 0): TrimSilenceResult => ({
    wav, trimmed: false, speechMs, silenceMs,
  })
  if (parsed === null) return unchanged()
  const frameMs = options.frameMs ?? 20
  const padMs = options.padMs ?? 200
  const minTrimMs = options.minTrimMs ?? 300
  const rmsFloor = options.rmsFloor ?? 0.0035
  const frameBytes = Math.max(2, Math.floor((VOICE_SAMPLE_RATE * frameMs) / 1000) << 1)
  const frames = Math.floor(parsed.dataBytes / frameBytes)
  if (frames === 0) return unchanged()

  const rms: number[] = []
  for (let frame = 0; frame < frames; frame++) {
    rms.push(frameRms(wav, parsed.dataStart, frame * frameBytes, frameBytes))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const threshold = Math.max(rmsFloor, noise * 4)
  const peak = sorted[sorted.length - 1] ?? 0
  if (peak < threshold) return unchanged(0, (parsed.dataBytes / VOICE_BYTES_PER_SECOND) * 1000)

  let first = rms.findIndex((value) => value >= threshold)
  if (first === -1) return unchanged()
  let last = first
  for (let frame = rms.length - 1; frame >= first; frame--) {
    if (rms[frame]! >= threshold) { last = frame; break }
  }

  const padFrames = Math.ceil(padMs / frameMs)
  let startByte = Math.max(0, (first - padFrames) * frameBytes)
  let endByte = Math.min(parsed.dataBytes, (last + 1 + padFrames) * frameBytes)
  // The final partial frame can contain the end of the last word.
  if (last === frames - 1 && parsed.dataBytes % frameBytes > 0) {
    const tailBytes = parsed.dataBytes % frameBytes
    if (frameRms(wav, parsed.dataStart, frames * frameBytes, tailBytes) >= threshold) {
      endByte = parsed.dataBytes
    }
  }

  const removedMs = ((startByte + (parsed.dataBytes - endByte)) / VOICE_BYTES_PER_SECOND) * 1000
  const speechMs = ((endByte - startByte) / VOICE_BYTES_PER_SECOND) * 1000
  const silenceMs = (parsed.dataBytes / VOICE_BYTES_PER_SECOND) * 1000 - speechMs
  if (removedMs < minTrimMs || endByte - startByte < 2) {
    return unchanged(speechMs, silenceMs)
  }
  return {
    wav: wrapPcmAsWav(wav.subarray(parsed.dataStart + startByte, parsed.dataStart + endByte)),
    trimmed: true,
    speechMs,
    silenceMs,
  }
}

/**
 * Splits a growing PCM stream into fixed-size segments. Pure state machine so
 * the recorder can be tested without a real microphone.
 */
export class VoiceSegmentTracker {
  private consumed = 0
  private segments = 0

  constructor(private readonly segmentBytes: number = VOICE_SEGMENT_BYTES) {}

  /** Byte offset (relative to the data chunk) that still needs transcription. */
  get pendingFrom(): number { return this.consumed }
  get count(): number { return this.segments }

  /** Completed segments available in `availableBytes` of captured PCM. */
  take(availableBytes: number): Array<{ from: number; to: number }> {
    const completed: Array<{ from: number; to: number }> = []
    while (availableBytes - this.consumed >= this.segmentBytes) {
      completed.push({ from: this.consumed, to: this.consumed + this.segmentBytes })
      this.consumed += this.segmentBytes
      this.segments++
    }
    return completed
  }
}

/** Joins already-recognized segments with the remaining tail transcript. */
export function mergeVoiceSegments(segments: string[], tail: string): string {
  return [...segments, tail]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ')
}
