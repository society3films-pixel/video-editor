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
    ensure_ffmpeg_init()?;
    let mut input = format::input(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let stream = input
        .streams()
        .best(Type::Audio)
        .ok_or("This file has no sound.")?;
    let index = stream.index();
    let time_base = stream.time_base();
    let mut decoder = codec::context::Context::from_parameters(stream.parameters())
        .and_then(|c| c.decoder().audio())
        .map_err(|e| e.to_string())?;
    let mut levels = Levels {
        frame_samples: ((ANALYSIS_RATE as u64 * frame_ms.max(1) as u64) / 1000).max(1) as usize,
        sum: 0.0,
        count: 0,
        out: Vec::new(),
    };
    let mut filter_graph: Option<filter::Graph> = None;
    let mut decoded = frame::Audio::empty();
    let mut feed = |decoder: &mut ffmpeg::decoder::Audio,
                    graph: &mut Option<filter::Graph>,
                    levels: &mut Levels|
     -> Result<(), String> {
        loop {
            match decoder.receive_frame(&mut decoded) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(format!("Cannot decode the sound: {e}")),
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
    loop {
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) => {}
            Err(ffmpeg::Error::Eof) => break,
            Err(e) => return Err(format!("Cannot read {path}: {e}")),
        }
        if packet.stream() != index {
            continue;
        }
        decoder.send_packet(&packet).map_err(|e| e.to_string())?;
        feed(&mut decoder, &mut filter_graph, &mut levels)?;
    }
    decoder.send_eof().map_err(|e| e.to_string())?;
    feed(&mut decoder, &mut filter_graph, &mut levels)?;
    if let Some(g) = filter_graph.as_mut() {
        g.get("in")
            .unwrap()
            .source()
            .flush()
            .map_err(|e| e.to_string())?;
        drain(g, &mut levels)?;
    }
    Ok(levels.out)
}

#[cfg(test)]
mod tests {
    use super::Levels;

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
