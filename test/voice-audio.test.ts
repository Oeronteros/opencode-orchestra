import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  VOICE_BYTES_PER_SECOND,
  VOICE_SAMPLE_RATE,
  VoiceSegmentTracker,
  mergeVoiceSegments,
  parseVoiceWav,
  sliceVoiceWav,
  trimVoiceSilence,
  wrapPcmAsWav,
} from '../src/voice-audio.js'

function tone(ms: number, amplitude = 0.3, frequency = 440): Buffer {
  const samples = Math.round((VOICE_SAMPLE_RATE * ms) / 1000)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / VOICE_SAMPLE_RATE) * amplitude * 32767), i * 2)
  }
  return pcm
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((VOICE_SAMPLE_RATE * ms) / 1000) * 2)
}

describe('voice WAV helpers', () => {
  it('round-trips the canonical ffmpeg profile and rejects foreign data', () => {
    const pcm = tone(100)
    const wav = wrapPcmAsWav(pcm)
    assert.deepEqual(parseVoiceWav(wav), { dataStart: 44, dataBytes: pcm.length })
    assert.equal(parseVoiceWav(Buffer.from('nope')), null)
    assert.equal(parseVoiceWav(Buffer.alloc(64)), null)
    const stereo = wrapPcmAsWav(pcm)
    stereo.writeUInt16LE(2, 22)
    assert.equal(parseVoiceWav(stereo), null)
  })

  it('slices an aligned range into a standalone WAV', () => {
    const pcm = tone(2000)
    const wav = wrapPcmAsWav(pcm)
    const from = 640 * 10
    const to = 640 * 40
    const sliced = sliceVoiceWav(wav, from, to)
    const parsed = parseVoiceWav(sliced)
    assert.equal(parsed?.dataBytes, to - from)
    assert.deepEqual(sliced.subarray(44), pcm.subarray(from, to))
    // Unaligned requests are snapped to whole samples.
    assert.equal(parseVoiceWav(sliceVoiceWav(wav, 3, to))?.dataBytes, to - 2)
  })

  it('trims leading and trailing silence while keeping padding around speech', () => {
    const wav = wrapPcmAsWav(Buffer.concat([silence(1000), tone(1000), silence(1000)]))
    const result = trimVoiceSilence(wav)
    assert.equal(result.trimmed, true)
    const keptMs = ((parseVoiceWav(result.wav)?.dataBytes ?? 0) / VOICE_BYTES_PER_SECOND) * 1000
    // 1000 ms speech + 2 x 200 ms pad, well below the original 3000 ms.
    assert.ok(keptMs >= 1300 && keptMs <= 1500, `kept ${keptMs} ms`)
    assert.ok(result.speechMs >= 1300 && result.speechMs <= 1500)
  })

  it('leaves already tight speech untouched and never breaks silence-only input', () => {
    const tight = wrapPcmAsWav(tone(1000))
    const kept = trimVoiceSilence(tight)
    assert.equal(kept.trimmed, false)
    assert.equal(kept.wav, tight)
    const quiet = wrapPcmAsWav(silence(500))
    const untouched = trimVoiceSilence(quiet)
    assert.equal(untouched.trimmed, false)
    assert.equal(untouched.wav, quiet)
  })

  it('keeps the final partial frame when the last word ends mid-frame', () => {
    // Speech runs to the very end of the recording, so the trailing partial
    // 20 ms frame still contains voice and must not be trimmed away.
    const pcm = Buffer.concat([silence(600), tone(1410)])
    const wav = wrapPcmAsWav(pcm)
    const result = trimVoiceSilence(wav)
    assert.equal(result.trimmed, true)
    const parsed = parseVoiceWav(result.wav)!
    const keptPcm = result.wav.subarray(44, 44 + parsed.dataBytes)
    assert.ok(keptPcm.length % 2 === 0)
    assert.ok(keptPcm.length >= (600 + 1410 - 600 + 200) * (VOICE_SAMPLE_RATE / 1000) * 2 - 64)
    // The 10 ms partial tail must survive: its samples are not all zero.
    assert.notDeepEqual(keptPcm.subarray(keptPcm.length - 320), Buffer.alloc(320))
  })

  it('passes through malformed audio unchanged for the caller to reject', () => {
    const invalid = Buffer.from('not a wav')
    const result = trimVoiceSilence(invalid)
    assert.equal(result.trimmed, false)
    assert.equal(result.wav, invalid)
  })
})

describe('voice segment tracker', () => {
  it('emits only completed fixed-size segments and leaves the tail pending', () => {
    const tracker = new VoiceSegmentTracker(100)
    assert.deepEqual(tracker.take(250), [{ from: 0, to: 100 }, { from: 100, to: 200 }])
    assert.equal(tracker.pendingFrom, 200)
    assert.equal(tracker.count, 2)
    assert.deepEqual(tracker.take(299), [])
    assert.deepEqual(tracker.take(300), [{ from: 200, to: 300 }])
    assert.deepEqual(tracker.take(300), [])
    assert.equal(tracker.pendingFrom, 300)
  })

  it('merges segment transcripts preserving order and dropping empties', () => {
    assert.equal(mergeVoiceSegments([], '  привет '), 'привет')
    assert.equal(mergeVoiceSegments(['раз', ''], 'два'), 'раз два')
    assert.equal(mergeVoiceSegments(['', '  '], ''), '')
  })
})
