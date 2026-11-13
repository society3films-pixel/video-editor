//! Sound level per short frame of a media file's audio, decoded natively with FFmpeg.
//!
//! Song detection, camera-angle sync and performance highlights only need the loudness over
//! time. Decoding hours of audio in the webview is slow; here it's a single pass at 8 kHz mono.

use super::frames::ensure_ffmpeg_init;
use ffmpeg::{codec, filter, format, frame, media::Type, Packet};
use ffmpeg_next as ffmpeg;

const ANALYSIS_RATE: u32 = 8_000;

fn graph(args: &str) -> Result<filter::Graph, ffmpeg::Error> {
    let mut graph = filter::Graph::new();
    graph.add(
        &filter::find("abuffer").ok_or(ffmpeg::Error::FilterNotFound)?,
        "in",
        args,
    )?;
    graph.add(
        &filter::find("abuffersink").ok_or(ffmpeg::Error::FilterNotFound)?,
        "out",
        "",
    )?;
    graph.output("in", 0)?.input("out", 0)?.parse(&format!(
        "aresample={ANALYSIS_RATE},aformat=sample_fmts=flt:channel_layouts=mono"
    ))?;
    graph.validate()?;
    Ok(graph)
}

/// Accumulates mono samples into RMS values per frame.
struct Levels {
    frame_samples: usize,
    sum: f64,
    count: usize,
    out: Vec<f32>,
}

impl Levels {
    fn push(&mut self, samples: &[f32]) {
        for &v in samples {
            self.sum += (v as f64) * (v as f64);
            self.count += 1;
            if self.count >= self.frame_samples {
                self.out.push((self.sum / self.count as f64).sqrt() as f32);
                self.sum = 0.0;
                self.count = 0;
            }
        }
    }
}

fn drain(graph: &mut filter::Graph, levels: &mut Levels) -> Result<(), String> {
    let mut filtered = frame::Audio::empty();
    loop {
        match graph.get("out").unwrap().sink().frame(&mut filtered) {
            Ok(()) => {}
            Err(ffmpeg::Error::Eof) => break,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
            Err(e) => return Err(e.to_string()),
        }
        let count = filtered.samples();
        let bytes = filtered.data(0);
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .take(count)
            .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        levels.push(&samples);
    }
    Ok(())
}

/// RMS per `frame_ms` milliseconds of the file's first audio stream (mono mix).
pub fn audio_levels_blocking(path: &str, frame_ms: u32) -> Result<Vec<f32>, String> {
    levels_blocking(path, frame_ms, None).map(|(_, levels)| levels)
}

/// Levels for `duration_sec` from `start_sec` (file time), at fine detail for precise sync.
/// Returns the file time of the first level frame (from the stream's own timestamps) and the levels.
pub fn audio_levels_window_blocking(
    path: &str,
    start_sec: f64,
    duration_sec: f64,
    frame_ms: u32,
) -> Result<(f64, Vec<f32>), String> {
    levels_blocking(
        path,
        frame_ms,
        Some((start_sec.max(0.0), duration_sec.max(0.1))),
    )
}

fn levels_blocking(
    path: &str,
    frame_ms: u32,
    window: Option<(f64, f64)>,
) -> Result<(f64, Vec<f32>), String> {
    ensure_ffmpeg_init()?;
    let mut input = format::input(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let stream = input
        .streams()
        .best(Type::Audio)
        .ok_or("This file has no sound.")?;
    let index = stream.index();
    let time_base = stream.time_base();
    let tb_sec = time_base.numerator() as f64 / time_base.denominator().max(1) as f64;
    let mut decoder = codec::context::Context::from_parameters(stream.parameters())
        .and_then(|c| c.decoder().audio())
        .map_err(|e| e.to_string())?;
    if let Some((start, _)) = window {
        // Land a little early; frames before the window are dropped below.
        let target = ((start - 1.0).max(0.0) * 1_000_000.0).round() as i64;
        input
            .seek(target, ..target)
            .map_err(|e| format!("Cannot seek in {path}: {e}"))?;
    }
    let frame_samples = ((ANALYSIS_RATE as u64 * frame_ms.max(1) as u64) / 1000).max(1) as usize;
    let frame_sec = frame_samples as f64 / ANALYSIS_RATE as f64;
    let mut levels = Levels {
        frame_samples,
        sum: 0.0,
        count: 0,
        out: Vec::new(),
    };
    // File time of the first decoded sample (stream timestamps; not always 0).
    let mut first_time: Option<f64> = None;
    let mut filter_graph: Option<filter::Graph> = None;
    let mut decoded = frame::Audio::empty();
    let mut done = false;
    let mut feed = |decoder: &mut ffmpeg::decoder::Audio,
                    graph: &mut Option<filter::Graph>,
                    levels: &mut Levels,
                    first_time: &mut Option<f64>,
                    packet_time: Option<f64>|
     -> Result<(), String> {
        loop {
            match decoder.receive_frame(&mut decoded) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(format!("Cannot decode the sound: {e}")),
            }
            if first_time.is_none() {
                *first_time = decoded
                    .pts()
                    .map(|pts| pts as f64 * tb_sec)
                    .or(packet_time)
                    .or(Some(0.0));
            }
            if graph.is_none() {
                let layout = decoded.channel_layout();
                let layout = if layout.is_empty() {
                    ffmpeg::ChannelLayout::default(decoded.channels() as i32)
                } else {
                    layout
                };
                decoded.set_channel_layout(layout);
                let args = format!(
                    "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
                    time_base,
                    decoded.rate(),
                    decoded.format().name(),
                    layout.bits()
                );
                *graph = Some(self::graph(&args).map_err(|e| e.to_string())?);
            }
            let g = graph.as_mut().unwrap();
            g.get("in")
                .unwrap()
                .source()
                .add(&decoded)
                .map_err(|e| e.to_string())?;
            drain(g, levels)?;
        }
        Ok(())
    };
    while !done {
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) => {}
            Err(ffmpeg::Error::Eof) => break,
            Err(e) => return Err(format!("Cannot read {path}: {e}")),
        }
        if packet.stream() != index {
            continue;
        }
        let packet_time = packet.pts().map(|pts| pts as f64 * tb_sec);
        decoder.send_packet(&packet).map_err(|e| e.to_string())?;
        feed(
            &mut decoder,
            &mut filter_graph,
            &mut levels,
            &mut first_time,
            packet_time,
        )?;
        if let (Some((start, duration)), Some(first)) = (window, first_time) {
            if first + levels.out.len() as f64 * frame_sec > start + duration + 0.5 {
                done = true;
            }
        }
    }
    if !done {
        decoder.send_eof().map_err(|e| e.to_string())?;
        feed(
            &mut decoder,
            &mut filter_graph,
            &mut levels,
            &mut first_time,
            None,
        )?;
        if let Some(g) = filter_graph.as_mut() {
            g.get("in")
                .unwrap()
                .source()
                .flush()
                .map_err(|e| e.to_string())?;
            drain(g, &mut levels)?;
        }
    }
    let first = first_time.unwrap_or(0.0);
    let Some((start, duration)) = window else {
        return Ok((first, levels.out));
    };
    let skip = (((start - first) / frame_sec).floor().max(0.0)) as usize;
    let take = (duration / frame_sec).ceil() as usize;
    let out: Vec<f32> = levels.out.into_iter().skip(skip).take(take).collect();
    Ok((first + skip as f64 * frame_sec, out))
}

/// Timecode of a file's first frame in seconds since midnight, if it carries one: a camera's
/// "timecode" tag (container or a stream) or a Broadcast WAV's time reference (sound recorders).
pub fn media_timecode_blocking(path: &str) -> Result<Option<f64>, String> {
    ensure_ffmpeg_init()?;
    let input = format::input(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let fps = input
        .streams()
        .best(Type::Video)
        .map(|stream| {
            let rate = stream.avg_frame_rate();
            if rate.denominator() > 0 && rate.numerator() > 0 {
                rate.numerator() as f64 / rate.denominator() as f64
            } else {
                30.0
            }
        })
        .unwrap_or(30.0);
    let mut tags: Vec<String> = Vec::new();
    if let Some(value) = input.metadata().get("timecode") {
        tags.push(value.to_string());
    }
    for stream in input.streams() {
        if let Some(value) = stream.metadata().get("timecode") {
            tags.push(value.to_string());
        }
    }
    if let Some(seconds) = tags.iter().find_map(|tag| parse_timecode(tag, fps)) {
        return Ok(Some(seconds));
    }
    // Broadcast WAV: samples since midnight.
    let reference = input
        .metadata()
        .get("time_reference")
        .and_then(|value| value.trim().parse::<f64>().ok());
    if let Some(samples) = reference {
        if let Some(stream) = input.streams().best(Type::Audio) {
            let rate = codec::context::Context::from_parameters(stream.parameters())
                .and_then(|c| c.decoder().audio())
                .map(|decoder| decoder.rate())
                .unwrap_or(48_000);
            if rate > 0 && samples > 0.0 {
                return Ok(Some(samples / rate as f64));
            }
        }
    }
    Ok(None)
}

/// "HH:MM:SS:FF" (or with ';' / '.' for drop frame) at `fps` → seconds.
fn parse_timecode(tag: &str, fps: f64) -> Option<f64> {
    let parts: Vec<&str> = tag
        .trim()
        .split(|c| c == ':' || c == ';' || c == '.')
        .collect();
    if parts.len() != 4 {
        return None;
    }
    let numbers: Option<Vec<f64>> = parts.iter().map(|p| p.parse::<f64>().ok()).collect();
    let n = numbers?;
    let nominal = fps.round().max(1.0);
    Some(n[0] * 3600.0 + n[1] * 60.0 + n[2] + n[3] / nominal)
}

#[cfg(test)]
mod tests {
    use super::{parse_timecode, Levels};

    #[test]
    fn timecode() {
        assert_eq!(parse_timecode("01:00:00:00", 25.0), Some(3600.0));
        assert_eq!(parse_timecode("10:20:30;15", 29.97), Some(37230.5));
        assert_eq!(parse_timecode("nonsense", 25.0), None);
    }

    #[test]
    fn rms_per_frame() {
        let mut levels = Levels {
            frame_samples: 4,
            sum: 0.0,
            count: 0,
            out: Vec::new(),
        };
        levels.push(&[0.5, -0.5, 0.5, -0.5, 0.0, 0.0]);
        levels.push(&[0.0, 0.0]);
        assert_eq!(levels.out.len(), 2);
        assert!((levels.out[0] - 0.5).abs() < 1e-6);
        assert!(levels.out[1].abs() < 1e-6);
    }
}
