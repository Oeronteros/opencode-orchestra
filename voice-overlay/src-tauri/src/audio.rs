//! Canonical 16 kHz mono PCM16 WAV helpers: silence trimming (energy VAD) and
//! segment slicing for progressive long-recording transcription. Mirrors the
//! TypeScript `src/voice-audio.ts` contract.

pub const WAV_HEADER_BYTES: usize = 44;
pub const SAMPLE_RATE: usize = 16000;
pub const BYTES_PER_SECOND: usize = SAMPLE_RATE * 2;

/// Whisper's natural 30 s window: one progressive segment.
pub const SEGMENT_SECONDS: usize = 30;
pub const SEGMENT_BYTES: usize = SEGMENT_SECONDS * BYTES_PER_SECOND;

/// Returns `(data_start, data_bytes)` for the canonical ffmpeg profile.
///
/// Walks the RIFF chunk list instead of assuming a 44-byte header: ffmpeg
/// inserts a `LIST`/`INFO` chunk before `data`, and the recorder may read the
/// file while ffmpeg still writes a placeholder `data` size.
pub fn parse_pcm_wav(wav: &[u8]) -> Option<(usize, usize)> {
    if wav.len() < WAV_HEADER_BYTES || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let u32_at = |offset: usize| u32::from_le_bytes(wav[offset..offset + 4].try_into().unwrap());
    let u16_at = |offset: usize| u16::from_le_bytes(wav[offset..offset + 2].try_into().unwrap());
    let mut offset = 12usize;
    let mut fmt_ok = false;
    while offset + 8 <= wav.len() {
        let id = &wav[offset..offset + 4];
        let size = u32_at(offset + 4) as usize;
        let body = offset + 8;
        if id == b"fmt " {
            if size < 16 || body + 16 > wav.len() {
                return None;
            }
            fmt_ok = u16_at(body) == 1
                && u16_at(body + 2) == 1
                && u32_at(body + 4) == SAMPLE_RATE as u32
                && u32_at(body + 8) == BYTES_PER_SECOND as u32
                && u16_at(body + 12) == 2
                && u16_at(body + 14) == 16;
        } else if id == b"data" {
            if !fmt_ok {
                return None;
            }
            let available = wav.len() - body;
            // While recording, ffmpeg writes 0/0xFFFFFFFF until the header is
            // finalized: trust the bytes actually present in that case.
            let declared = if size == 0 || size == u32::MAX as usize {
                available
            } else {
                size.min(available)
            };
            let data_bytes = declared & !1;
            if data_bytes == 0 {
                return None;
            }
            return Some((body, data_bytes));
        }
        // RIFF chunks are word-aligned: odd sizes carry a pad byte.
        offset = body + size + (size & 1);
    }
    None
}

pub fn wrap_pcm_as_wav(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(WAV_HEADER_BYTES + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    out.extend_from_slice(&(BYTES_PER_SECOND as u32).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Extracts an aligned byte range from a canonical WAV into a standalone WAV.
pub fn slice_wav(wav: &[u8], start_byte: usize, end_byte: usize) -> Vec<u8> {
    let Some((data_start, data_bytes)) = parse_pcm_wav(wav) else {
        return wav.to_vec();
    };
    let start = start_byte.min(data_bytes) & !1;
    let end = end_byte.min(data_bytes) & !1;
    if end <= start {
        return wrap_pcm_as_wav(&[]);
    }
    wrap_pcm_as_wav(&wav[data_start + start..data_start + end])
}

fn frame_rms(wav: &[u8], data_start: usize, frame_start: usize, frame_bytes: usize) -> f32 {
    let samples = frame_bytes / 2;
    if samples == 0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for index in 0..samples {
        let offset = data_start + frame_start + index * 2;
        let sample = i16::from_le_bytes([wav[offset], wav[offset + 1]]) as f64 / 32768.0;
        sum += sample * sample;
    }
    (sum / samples as f64).sqrt() as f32
}

/// Trims leading/trailing near-silence with an adaptive noise floor (10th
/// percentile of frame RMS). Returns the input unchanged when no meaningful
/// win is available.
pub fn trim_silence(wav: &[u8]) -> Vec<u8> {
    const FRAME_MS: usize = 20;
    const PAD_MS: usize = 200;
    const MIN_TRIM_MS: f64 = 300.0;
    const RMS_FLOOR: f32 = 0.0035;
    let Some((data_start, data_bytes)) = parse_pcm_wav(wav) else {
        return wav.to_vec();
    };
    let frame_bytes = ((SAMPLE_RATE * FRAME_MS) / 1000) * 2;
    let frames = data_bytes / frame_bytes;
    if frames == 0 {
        return wav.to_vec();
    }
    let rms: Vec<f32> = (0..frames)
        .map(|frame| frame_rms(wav, data_start, frame * frame_bytes, frame_bytes))
        .collect();
    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise = sorted[sorted.len() / 10];
    let threshold = (noise * 4.0).max(RMS_FLOOR);
    let peak = *sorted.last().unwrap();
    if peak < threshold {
        return wav.to_vec();
    }
    let Some(first) = rms.iter().position(|value| *value >= threshold) else {
        return wav.to_vec();
    };
    let mut last = first;
    for frame in (first..rms.len()).rev() {
        if rms[frame] >= threshold {
            last = frame;
            break;
        }
    }
    let pad_frames = PAD_MS.div_ceil(FRAME_MS);
    let start_byte = first.saturating_sub(pad_frames) * frame_bytes;
    let mut end_byte = ((last + 1 + pad_frames) * frame_bytes).min(data_bytes);
    // The final partial frame can contain the end of the last word.
    if last == frames - 1 && data_bytes % frame_bytes > 0 {
        let tail_bytes = data_bytes % frame_bytes;
        if frame_rms(wav, data_start, frames * frame_bytes, tail_bytes) >= threshold {
            end_byte = data_bytes;
        }
    }
    let removed_ms =
        ((start_byte + (data_bytes - end_byte)) as f64 / BYTES_PER_SECOND as f64) * 1000.0;
    if removed_ms < MIN_TRIM_MS || end_byte <= start_byte {
        return wav.to_vec();
    }
    wrap_pcm_as_wav(&wav[data_start + start_byte..data_start + end_byte])
}

/// Joins recognized segments with the remaining tail transcript.
pub fn merge_segments(segments: &[String], tail: &str) -> String {
    segments
        .iter()
        .map(|part| part.trim())
        .chain(std::iter::once(tail.trim()))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: usize) -> Vec<u8> {
        let samples = SAMPLE_RATE * ms / 1000;
        let mut pcm = Vec::with_capacity(samples * 2);
        for index in 0..samples {
            let value = ((2.0 * std::f64::consts::PI * 440.0 * index as f64 / SAMPLE_RATE as f64)
                .sin()
                * 0.3
                * 32767.0) as i16;
            pcm.extend_from_slice(&value.to_le_bytes());
        }
        pcm
    }

    fn silence(ms: usize) -> Vec<u8> {
        vec![0u8; SAMPLE_RATE * ms / 1000 * 2]
    }

    /// Canonical WAV plus the `LIST`/`INFO`/`ISFT` software metadata chunk that
    /// recent ffmpeg builds insert between `fmt ` and `data`.
    fn with_info_chunk(pcm: &[u8]) -> Vec<u8> {
        let software = b"Lavf63.1.102\0";
        let isft_size = (4 + software.len()) as u32;
        let list_body = 4 + 4 + 4 + software.len();
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
        out.extend_from_slice(&(BYTES_PER_SECOND as u32).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"LIST");
        out.extend_from_slice(&(list_body as u32).to_le_bytes());
        out.extend_from_slice(b"INFOISFT");
        out.extend_from_slice(&isft_size.to_le_bytes());
        out.extend_from_slice(software);
        if list_body % 2 == 1 {
            out.push(0);
        }
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        out.extend_from_slice(pcm);
        let riff = (out.len() - 8) as u32;
        out[4..8].copy_from_slice(&riff.to_le_bytes());
        out
    }

    #[test]
    fn wav_roundtrip_and_rejection() {
        let pcm = tone(100);
        let wav = wrap_pcm_as_wav(&pcm);
        assert_eq!(parse_pcm_wav(&wav), Some((44, pcm.len())));
        assert_eq!(parse_pcm_wav(b"nope"), None);
        assert_eq!(parse_pcm_wav(&[0u8; 64]), None);
        let mut stereo = wav.clone();
        stereo[22] = 2;
        assert_eq!(parse_pcm_wav(&stereo), None);
    }

    #[test]
    fn trims_leading_and_trailing_silence_with_padding() {
        let mut pcm = silence(1000);
        pcm.extend(tone(1000));
        pcm.extend(silence(1000));
        let wav = wrap_pcm_as_wav(&pcm);
        let trimmed = trim_silence(&wav);
        let (_, bytes) = parse_pcm_wav(&trimmed).unwrap();
        let kept_ms = bytes as f64 / BYTES_PER_SECOND as f64 * 1000.0;
        assert!(trimmed != wav);
        assert!((1300.0..=1500.0).contains(&kept_ms), "kept {kept_ms} ms");
    }

    #[test]
    fn leaves_tight_and_silent_recordings_untouched() {
        let tight = wrap_pcm_as_wav(&tone(1000));
        assert_eq!(trim_silence(&tight), tight);
        let quiet = wrap_pcm_as_wav(&silence(500));
        assert_eq!(trim_silence(&quiet), quiet);
    }

    #[test]
    fn slicing_produces_standalone_aligned_wavs() {
        let pcm = tone(2000);
        let wav = wrap_pcm_as_wav(&pcm);
        let sliced = slice_wav(&wav, 640 * 10, 640 * 40);
        let (_, bytes) = parse_pcm_wav(&sliced).unwrap();
        assert_eq!(bytes, 640 * 30);
        assert_eq!(&sliced[44..], &pcm[640 * 10..640 * 40]);
        let unaligned = slice_wav(&wav, 3, 640 * 40);
        assert_eq!(parse_pcm_wav(&unaligned).unwrap().1, 640 * 40 - 2);
    }

    #[test]
    fn parses_wav_with_a_metadata_chunk_before_data() {
        let pcm = tone(500);
        let wav = with_info_chunk(&pcm);
        assert_eq!(parse_pcm_wav(&wav), Some((78, pcm.len())));
    }

    #[test]
    fn trims_and_slices_wavs_with_metadata_chunks() {
        let mut pcm = silence(1000);
        pcm.extend(tone(1000));
        pcm.extend(silence(1000));
        let wav = with_info_chunk(&pcm);
        let trimmed = trim_silence(&wav);
        assert!(trimmed != wav);
        let (data_start, bytes) = parse_pcm_wav(&trimmed).unwrap();
        assert_eq!(data_start, WAV_HEADER_BYTES);
        let kept_ms = bytes as f64 / BYTES_PER_SECOND as f64 * 1000.0;
        assert!((1300.0..=1500.0).contains(&kept_ms), "kept {kept_ms} ms");
        let sliced = slice_wav(&wav, 640 * 10, 640 * 40);
        assert_eq!(&sliced[44..], &pcm[640 * 10..640 * 40]);
    }

    #[test]
    fn merges_segments_in_order_and_drops_empties() {
        assert_eq!(merge_segments(&[], "  привет "), "привет");
        assert_eq!(
            merge_segments(&["раз".to_string(), String::new()], "два"),
            "раз два"
        );
        assert_eq!(merge_segments(&[String::new(), "  ".to_string()], ""), "");
    }
}
