//! Native render of a Folder → draft timeline (the long-form MP4), with FFmpeg.
//!
//! The webview renderer decodes, draws and encodes every frame through JavaScript, which is slow
//! on hours of 4K. Here each clip is decoded natively (multi-threaded), scaled to the output by
//! FFmpeg, B-roll is cross-faded over the camera, captions are blended from small pre-drawn
//! images, and the H.264 encode goes to the graphics card through Media Foundation where it can
//! (NVENC/AMF/Quick Sync behind it), with a software encoder as the fallback.

use ffmpeg::{codec, encoder, filter, format, frame, media::Type, Packet, Rational};
use ffmpeg_next as ffmpeg;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

const SAMPLE_RATE: i32 = 48_000;
const EDGE_FADE_SEC: f64 = 0.012;
const BROLL_FADE_SEC: f64 = 0.2;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftClip {
    pub path: String,
    pub in_sec: f64,
    pub out_sec: f64,
    pub start_sec: f64,
}

impl DraftClip {
    fn end_sec(&self) -> f64 {
        self.start_sec + (self.out_sec - self.in_sec)
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftCaption {
    pub start: f64,
    pub end: f64,
    pub x: i32,
    pub y: i32,
    /// A PNG of the caption (drawn by the app), placed at x, y on the output frame.
    pub png_base64: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftRenderSpec {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_sec: f64,
    pub video: Vec<DraftClip>,
    #[serde(default)]
    pub broll: Vec<DraftClip>,
    #[serde(default)]
    pub audio: Vec<DraftClip>,
    #[serde(default)]
    pub captions: Vec<DraftCaption>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftRenderSummary {
    /// The H.264 encoder used, e.g. "h264_mf (hardware)".
    pub encoder: String,
    pub frames: u64,
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Render cancelled".into())
    } else {
        Ok(())
    }
}

fn is_again(error: &ffmpeg::Error) -> bool {
    matches!(error, ffmpeg::Error::Other { errno } if *errno == ffmpeg::error::EAGAIN)
}

fn graph(source: &str, args: &str, sink: &str, spec: &str) -> Result<filter::Graph, String> {
    let mut graph = filter::Graph::new();
    let run = |graph: &mut filter::Graph| -> Result<(), ffmpeg::Error> {
        graph.add(
            &filter::find(source).ok_or(ffmpeg::Error::FilterNotFound)?,
            "in",
            args,
        )?;
        graph.add(
            &filter::find(sink).ok_or(ffmpeg::Error::FilterNotFound)?,
            "out",
            "",
        )?;
        graph.output("in", 0)?.input("out", 0)?.parse(spec)?;
        graph.validate()
    };
    run(&mut graph).map_err(|e| format!("Cannot set up the filter ({spec}): {e}"))?;
    Ok(graph)
}

fn stream_start_sec(stream: &ffmpeg::Stream<'_>) -> f64 {
    let tb = stream.time_base();
    let start = stream.start_time();
    if start == ffmpeg::ffi::AV_NOPTS_VALUE || tb.denominator() == 0 {
        0.0
    } else {
        start as f64 * tb.numerator() as f64 / tb.denominator() as f64
    }
}

fn open_decoder_context(stream: &ffmpeg::Stream<'_>) -> Result<codec::context::Context, String> {
    let mut context =
        codec::context::Context::from_parameters(stream.parameters()).map_err(|e| e.to_string())?;
    context.set_threading(codec::threading::Config {
        kind: codec::threading::Type::Frame,
        count: 0,
    });
    Ok(context)
}

/// One output-sized NV12 picture.
#[derive(Clone)]
struct Picture {
    y: Vec<u8>,
    uv: Vec<u8>,
}

impl Picture {
    fn black(width: usize, height: usize) -> Self {
        Self {
            y: vec![16; width * height],
            uv: vec![128; width * height / 2],
        }
    }

    fn from_frame(frame: &frame::Video, width: usize, height: usize) -> Self {
        let mut picture = Self {
            y: vec![0; width * height],
            uv: vec![0; width * height / 2],
        };
        let (y_stride, uv_stride) = (frame.stride(0), frame.stride(1));
        let (y_data, uv_data) = (frame.data(0), frame.data(1));
        for row in 0..height {
            picture.y[row * width..(row + 1) * width]
                .copy_from_slice(&y_data[row * y_stride..row * y_stride + width]);
        }
        for row in 0..height / 2 {
            picture.uv[row * width..(row + 1) * width]
                .copy_from_slice(&uv_data[row * uv_stride..row * uv_stride + width]);
        }
        picture
    }

    /// self = self × (1 − a) + other × a.
    fn blend(&mut self, other: &Picture, alpha: f32) {
        if alpha >= 0.999 {
            self.y.copy_from_slice(&other.y);
            self.uv.copy_from_slice(&other.uv);
            return;
        }
        let a = (alpha.clamp(0.0, 1.0) * 256.0) as u32;
        let mix = |dst: &mut [u8], src: &[u8]| {
            for (d, s) in dst.iter_mut().zip(src) {
                *d = ((*d as u32 * (256 - a) + *s as u32 * a) >> 8) as u8;
            }
        };
        mix(&mut self.y, &other.y);
        mix(&mut self.uv, &other.uv);
    }
}

/// A caption image converted to NV12 values with alpha, at its place on the frame.
struct CaptionOverlay {
    start: f64,
    end: f64,
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    luma: Vec<u8>,
    luma_alpha: Vec<u8>,
    /// Interleaved U, V at half resolution (w/2 × h/2), and their alpha.
    chroma: Vec<u8>,
    chroma_alpha: Vec<u8>,
}

impl CaptionOverlay {
    fn new(caption: &DraftCaption, frame_w: usize, frame_h: usize) -> Result<Option<Self>, String> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(caption.png_base64.as_bytes())
            .map_err(|e| format!("Bad caption image: {e}"))?;
        let image = image::load_from_memory(&bytes)
            .map_err(|e| format!("Bad caption image: {e}"))?
            .to_rgba8();
        // Even position and size, clipped to the frame.
        let x0 = (caption.x.max(0) as usize) & !1;
        let y0 = (caption.y.max(0) as usize) & !1;
        if x0 >= frame_w || y0 >= frame_h {
            return Ok(None);
        }
        let w = (image.width() as usize).min(frame_w - x0) & !1;
        let h = (image.height() as usize).min(frame_h - y0) & !1;
        if w == 0 || h == 0 {
            return Ok(None);
        }
        let mut luma = vec![0; w * h];
        let mut luma_alpha = vec![0; w * h];
        let mut chroma = vec![0; w * h / 2];
        let mut chroma_alpha = vec![0; w * h / 4];
        for row in 0..h {
            for col in 0..w {
                let p = image.get_pixel(col as u32, row as u32).0;
                let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
                luma[row * w + col] = (16.0 + 0.1826 * r + 0.6142 * g + 0.0620 * b)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                luma_alpha[row * w + col] = p[3];
            }
        }
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                let (mut r, mut g, mut b, mut a) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                for dy in 0..2 {
                    for dx in 0..2 {
                        let p = image
                            .get_pixel((col * 2 + dx) as u32, (row * 2 + dy) as u32)
                            .0;
                        let alpha = p[3] as f32;
                        r += p[0] as f32 * alpha;
                        g += p[1] as f32 * alpha;
                        b += p[2] as f32 * alpha;
                        a += alpha;
                    }
                }
                if a > 0.0 {
                    r /= a;
                    g /= a;
                    b /= a;
                }
                let u = 128.0 - 0.1006 * r - 0.3386 * g + 0.4392 * b;
                let v = 128.0 + 0.4392 * r - 0.3989 * g - 0.0403 * b;
                chroma[row * w + col * 2] = u.round().clamp(0.0, 255.0) as u8;
                chroma[row * w + col * 2 + 1] = v.round().clamp(0.0, 255.0) as u8;
                chroma_alpha[row * (w / 2) + col] = (a / 4.0).round() as u8;
            }
        }
        Ok(Some(Self {
            start: caption.start,
            end: caption.end,
            x: x0,
            y: y0,
            w,
            h,
            luma,
            luma_alpha,
            chroma,
            chroma_alpha,
        }))
    }

    fn draw(&self, picture: &mut Picture, frame_w: usize) {
        let over = |d: &mut u8, s: u8, a: u8| {
            if a == 0 {
                return;
            }
            let a = a as u32;
            *d = ((*d as u32 * (255 - a) + s as u32 * a) / 255) as u8;
        };
        for row in 0..self.h {
            let base = (self.y + row) * frame_w + self.x;
            for col in 0..self.w {
                over(
                    &mut picture.y[base + col],
                    self.luma[row * self.w + col],
                    self.luma_alpha[row * self.w + col],
                );
            }
        }
        for row in 0..self.h / 2 {
            let base = (self.y / 2 + row) * frame_w + self.x;
            for col in 0..self.w / 2 {
                let a = self.chroma_alpha[row * (self.w / 2) + col];
                over(
                    &mut picture.uv[base + col * 2],
                    self.chroma[row * self.w + col * 2],
                    a,
                );
                over(
                    &mut picture.uv[base + col * 2 + 1],
                    self.chroma[row * self.w + col * 2 + 1],
                    a,
                );
            }
        }
    }
}

/// Reads one clip's frames in order, scaled to the output, holding the latest frame at or before
/// a requested file time.
struct ClipReader {
    input: format::context::Input,
    decoder: ffmpeg::decoder::Video,
    graph: Option<filter::Graph>,
    index: usize,
    tb: Rational,
    start: f64,
    width: usize,
    height: usize,
    packets_done: bool,
    decoder_done: bool,
    current: Option<(f64, Picture)>,
    upcoming: Option<(f64, Picture)>,
    exhausted: bool,
}

impl ClipReader {
    fn open(path: &str, in_sec: f64, width: usize, height: usize) -> Result<Self, String> {
        let mut input = format::input(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        let stream = input
            .streams()
            .best(Type::Video)
            .ok_or_else(|| format!("{path} has no picture"))?;
        let index = stream.index();
        let tb = stream.time_base();
        let start = stream_start_sec(&stream);
        let decoder = open_decoder_context(&stream)?
            .decoder()
            .video()
            .map_err(|e| format!("Cannot decode {path}: {e}"))?;
        if in_sec > 1.0 {
            let target = ((start + in_sec - 1.0) * 1_000_000.0) as i64;
            input
                .seek(target, ..target)
                .map_err(|e| format!("Cannot seek in {path}: {e}"))?;
        }
        Ok(Self {
            input,
            decoder,
            graph: None,
            index,
            tb,
            start,
            width,
            height,
            packets_done: false,
            decoder_done: false,
            current: None,
            upcoming: None,
            exhausted: false,
        })
    }

    fn scale_spec(&self, src_w: u32, src_h: u32) -> String {
        let (w, h) = (self.width as f64, self.height as f64);
        let cover = (w / src_w as f64).max(h / src_h as f64);
        let contain = (w / src_w as f64).min(h / src_h as f64);
        // Fill the frame when that only crops a little; otherwise fit with black bars.
        if cover / contain < 1.15 {
            format!(
                "scale={}:{}:force_original_aspect_ratio=increase,crop={}:{},setsar=1,format=nv12",
                self.width, self.height, self.width, self.height
            )
        } else {
            format!(
                "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=nv12",
                self.width, self.height, self.width, self.height
            )
        }
    }

    /// The next scaled frame and its file time, or None at the end.
    fn pull(&mut self) -> Result<Option<(f64, Picture)>, String> {
        let tb_sec = self.tb.numerator() as f64 / self.tb.denominator().max(1) as f64;
        loop {
            if let Some(graph) = self.graph.as_mut() {
                let mut filtered = frame::Video::empty();
                match graph.get("out").unwrap().sink().frame(&mut filtered) {
                    Ok(()) => {
                        let t = filtered.pts().unwrap_or(0) as f64 * tb_sec - self.start;
                        return Ok(Some((
                            t,
                            Picture::from_frame(&filtered, self.width, self.height),
                        )));
                    }
                    Err(ffmpeg::Error::Eof) => return Ok(None),
                    Err(e) if is_again(&e) => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            if self.decoder_done {
                return Ok(None);
            }
            let mut decoded = frame::Video::empty();
            match self.decoder.receive_frame(&mut decoded) {
                Ok(()) => {
                    let timestamp = decoded.timestamp();
                    decoded.set_pts(timestamp);
                    if self.graph.is_none() {
                        let pixel_format: ffmpeg::ffi::AVPixelFormat = decoded.format().into();
                        let args = format!(
                            "video_size={}x{}:pix_fmt={}:time_base={}:pixel_aspect=1/1",
                            decoded.width(),
                            decoded.height(),
                            pixel_format as i32,
                            self.tb
                        );
                        let spec = self.scale_spec(decoded.width(), decoded.height());
                        self.graph = Some(graph("buffer", &args, "buffersink", &spec)?);
                    }
                    self.graph
                        .as_mut()
                        .unwrap()
                        .get("in")
                        .unwrap()
                        .source()
                        .add(&decoded)
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                Err(ffmpeg::Error::Eof) => {
                    // No more frames from the decoder: flush the filter and drain it (above).
                    self.decoder_done = true;
                    match self.graph.as_mut() {
                        Some(graph) => graph
                            .get("in")
                            .unwrap()
                            .source()
                            .flush()
                            .map_err(|e| e.to_string())?,
                        None => return Ok(None),
                    }
                    continue;
                }
                Err(e) if is_again(&e) => {}
                Err(e) => return Err(format!("Cannot decode the video: {e}")),
            }
            if self.packets_done {
                continue;
            }
            let mut packet = Packet::empty();
            match packet.read(&mut self.input) {
                Ok(()) => {
                    if packet.stream() == self.index {
                        self.decoder
                            .send_packet(&packet)
                            .map_err(|e| e.to_string())?;
                    }
                }
                Err(ffmpeg::Error::Eof) => {
                    self.packets_done = true;
                    self.decoder.send_eof().map_err(|e| e.to_string())?;
                }
                Err(e) => return Err(format!("Cannot read the video: {e}")),
            }
        }
    }

    /// The latest frame at or before file time `t` (None before the clip's first frame).
    fn frame_at(&mut self, t: f64) -> Result<Option<&Picture>, String> {
        loop {
            if self.upcoming.is_none() && !self.exhausted {
                self.upcoming = self.pull()?;
                if self.upcoming.is_none() {
                    self.exhausted = true;
                }
            }
            match &self.upcoming {
                Some((time, _)) if *time <= t + 1e-4 => self.current = self.upcoming.take(),
                _ => break,
            }
        }
        Ok(self.current.as_ref().map(|(_, picture)| picture))
    }
}

/// Reads one clip's sound as 48 kHz stereo, from any file time.
struct AudioReader {
    input: format::context::Input,
    decoder: ffmpeg::decoder::Audio,
    graph: Option<filter::Graph>,
    index: usize,
    tb: Rational,
    start: f64,
    done: bool,
    /// Buffered samples starting at file time `buffer_t`.
    buffer_t: f64,
    left: VecDeque<f32>,
    right: VecDeque<f32>,
}

impl AudioReader {
    fn open(path: &str, in_sec: f64) -> Result<Option<Self>, String> {
        let mut input = format::input(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        let Some(stream) = input.streams().best(Type::Audio) else {
            return Ok(None);
        };
        let index = stream.index();
        let tb = stream.time_base();
        let start = stream_start_sec(&stream);
        let decoder = open_decoder_context(&stream)?
            .decoder()
            .audio()
            .map_err(|e| format!("Cannot decode {path}'s sound: {e}"))?;
        if in_sec > 1.0 {
            let target = ((start + in_sec - 1.0) * 1_000_000.0) as i64;
            input
                .seek(target, ..target)
                .map_err(|e| format!("Cannot seek in {path}: {e}"))?;
        }
        Ok(Some(Self {
            input,
            decoder,
            graph: None,
            index,
            tb,
            start,
            done: false,
            buffer_t: f64::NAN,
            left: VecDeque::new(),
            right: VecDeque::new(),
        }))
    }

    fn take_filtered(&mut self) -> Result<bool, String> {
        let Some(graph) = self.graph.as_mut() else {
            return Ok(false);
        };
        let mut any = false;
        let mut filtered = frame::Audio::empty();
        loop {
            match graph.get("out").unwrap().sink().frame(&mut filtered) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(e) if is_again(&e) => break,
                Err(e) => return Err(e.to_string()),
            }
            let t = filtered.pts().unwrap_or(0) as f64 / SAMPLE_RATE as f64 - self.start;
            let count = filtered.samples();
            if self.buffer_t.is_nan() {
                self.buffer_t = t;
            } else {
                // Fill small gaps in the stream with silence so time stays exact.
                let expected = self.buffer_t + self.left.len() as f64 / SAMPLE_RATE as f64;
                let gap = ((t - expected) * SAMPLE_RATE as f64).round() as i64;
                if gap > 0 && gap < SAMPLE_RATE as i64 * 5 {
                    self.left.extend(std::iter::repeat(0.0).take(gap as usize));
                    self.right.extend(std::iter::repeat(0.0).take(gap as usize));
                }
            }
            let l = filtered.plane::<f32>(0);
            let r = filtered.plane::<f32>(1);
            self.left.extend(&l[..count]);
            self.right.extend(&r[..count]);
            any = true;
        }
        Ok(any)
    }

    fn decode_more(&mut self) -> Result<(), String> {
        loop {
            if self.take_filtered()? {
                return Ok(());
            }
            if self.done {
                return Ok(());
            }
            let mut decoded = frame::Audio::empty();
            match self.decoder.receive_frame(&mut decoded) {
                Ok(()) => {
                    let timestamp = decoded.timestamp();
                    decoded.set_pts(timestamp);
                    if self.graph.is_none() {
                        let layout = decoded.channel_layout();
                        let layout = if layout.is_empty() {
                            ffmpeg::ChannelLayout::default(decoded.channels() as i32)
                        } else {
                            layout
                        };
                        decoded.set_channel_layout(layout);
                        let args = format!(
                            "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
                            self.tb,
                            decoded.rate(),
                            decoded.format().name(),
                            layout.bits()
                        );
                        let spec = format!("aresample={SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo");
                        self.graph = Some(graph("abuffer", &args, "abuffersink", &spec)?);
                    }
                    self.graph
                        .as_mut()
                        .unwrap()
                        .get("in")
                        .unwrap()
                        .source()
                        .add(&decoded)
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                Err(ffmpeg::Error::Eof) => {
                    self.done = true;
                    if let Some(graph) = self.graph.as_mut() {
                        graph
                            .get("in")
                            .unwrap()
                            .source()
                            .flush()
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                Err(e) if is_again(&e) => {}
                Err(e) => return Err(format!("Cannot decode the sound: {e}")),
            }
            let mut packet = Packet::empty();
            match packet.read(&mut self.input) {
                Ok(()) => {
                    if packet.stream() == self.index {
                        self.decoder
                            .send_packet(&packet)
                            .map_err(|e| e.to_string())?;
                    }
                }
                Err(ffmpeg::Error::Eof) => {
                    self.decoder.send_eof().map_err(|e| e.to_string())?;
                }
                Err(e) => return Err(format!("Cannot read the sound: {e}")),
            }
        }
    }

    /// `count` samples from file time `from` (silence where the file has none).
    fn read(
        &mut self,
        from: f64,
        count: usize,
        left: &mut Vec<f32>,
        right: &mut Vec<f32>,
    ) -> Result<(), String> {
        let end = from + count as f64 / SAMPLE_RATE as f64;
        while !self.done
            && (self.buffer_t.is_nan()
                || (self.buffer_t + (self.left.len() as f64) / (SAMPLE_RATE as f64)) < end)
        {
            self.decode_more()?;
        }
        if self.buffer_t.is_nan() {
            left.extend(std::iter::repeat(0.0).take(count));
            right.extend(std::iter::repeat(0.0).take(count));
            return Ok(());
        }
        // Drop what's before `from`.
        let skip = ((from - self.buffer_t) * SAMPLE_RATE as f64).round();
        if skip > 0.0 {
            let skip = (skip as usize).min(self.left.len());
            self.left.drain(..skip);
            self.right.drain(..skip);
            self.buffer_t += skip as f64 / SAMPLE_RATE as f64;
        }
        // Silence before the buffer starts.
        let lead = (((self.buffer_t - from) * SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize)
            .min(count);
        left.extend(std::iter::repeat(0.0).take(lead));
        right.extend(std::iter::repeat(0.0).take(lead));
        let take = (count - lead).min(self.left.len());
        left.extend(self.left.drain(..take));
        right.extend(self.right.drain(..take));
        self.buffer_t += take as f64 / SAMPLE_RATE as f64;
        let rest = count - lead - take;
        left.extend(std::iter::repeat(0.0).take(rest));
        right.extend(std::iter::repeat(0.0).take(rest));
        Ok(())
    }
}

/// The sound track: clips in timeline order, silence between them.
struct AudioTimeline {
    clips: Vec<DraftClip>,
    reader: Option<(usize, Option<AudioReader>)>,
    position: u64,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl AudioTimeline {
    fn new(mut clips: Vec<DraftClip>) -> Self {
        clips.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
        Self {
            clips,
            reader: None,
            position: 0,
            left: Vec::new(),
            right: Vec::new(),
        }
    }

    /// Produces samples up to timeline time `until`.
    fn fill_until(&mut self, until: f64) -> Result<(), String> {
        let target = (until * SAMPLE_RATE as f64).round() as u64;
        while self.position < target {
            let t = self.position as f64 / SAMPLE_RATE as f64;
            let index = self
                .clips
                .iter()
                .position(|c| t >= c.start_sec - 1e-9 && t < c.end_sec() - 1e-9);
            let Some(index) = index else {
                let next = self
                    .clips
                    .iter()
                    .map(|c| (c.start_sec * SAMPLE_RATE as f64).round() as u64)
                    .filter(|&s| s > self.position)
                    .min()
                    .unwrap_or(target)
                    .min(target);
                let n = (next - self.position).max(1) as usize;
                self.left.extend(std::iter::repeat(0.0).take(n));
                self.right.extend(std::iter::repeat(0.0).take(n));
                self.position += n as u64;
                continue;
            };
            let clip = self.clips[index].clone();
            if self.reader.as_ref().map(|(i, _)| *i) != Some(index) {
                self.reader = Some((index, AudioReader::open(&clip.path, clip.in_sec)?));
            }
            let clip_end =
                ((clip.end_sec() * SAMPLE_RATE as f64).round() as u64).max(self.position + 1);
            let n = (clip_end.min(target) - self.position).min(SAMPLE_RATE as u64) as usize;
            let from = clip.in_sec + (t - clip.start_sec);
            let first = self.left.len();
            match self.reader.as_mut().unwrap().1.as_mut() {
                Some(reader) => reader.read(from, n, &mut self.left, &mut self.right)?,
                None => {
                    self.left.extend(std::iter::repeat(0.0).take(n));
                    self.right.extend(std::iter::repeat(0.0).take(n));
                }
            }
            // Short fades at the clip's edges (no clicks at cuts).
            for k in 0..n {
                let tt = t + k as f64 / SAMPLE_RATE as f64;
                let edge = ((tt - clip.start_sec) / EDGE_FADE_SEC)
                    .min((clip.end_sec() - tt) / EDGE_FADE_SEC);
                if edge < 1.0 {
                    let g = edge.max(0.0) as f32;
                    self.left[first + k] *= g;
                    self.right[first + k] *= g;
                }
            }
            self.position += n as u64;
        }
        Ok(())
    }
}

fn drain_packets(
    encoder: &mut codec::encoder::Encoder,
    index: usize,
    time_base: Rational,
    output: &mut format::context::Output,
) -> Result<(), String> {
    let mut packet = Packet::empty();
    loop {
        match encoder.receive_packet(&mut packet) {
            Ok(()) => {
                packet.set_stream(index);
                packet.set_position(-1);
                let out_tb = output
                    .stream(index)
                    .ok_or("Missing output stream")?
                    .time_base();
                packet.rescale_ts(time_base, out_tb);
                packet
                    .write_interleaved(output)
                    .map_err(|e| e.to_string())?;
            }
            Err(ffmpeg::Error::Eof) => break,
            Err(e) if is_again(&e) => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn frame_rate(fps: f64) -> Rational {
    for (nominal, rate) in [
        (23.976, Rational(24000, 1001)),
        (29.97, Rational(30000, 1001)),
        (59.94, Rational(60000, 1001)),
    ] {
        if (fps - nominal).abs() < 0.01 {
            return rate;
        }
    }
    Rational(fps.round().clamp(1.0, 240.0) as i32, 1)
}

/// The H.264 encoder: the graphics card through Media Foundation first, then software.
fn open_video_encoder(
    width: u32,
    height: u32,
    rate: Rational,
    output: &mut format::context::Output,
) -> Result<(encoder::Video, usize, String), String> {
    let fps = rate.numerator() as f64 / rate.denominator() as f64;
    let bit_rate =
        ((width as f64 * height as f64 * fps * 0.12) as usize).clamp(4_000_000, 60_000_000);
    let attempts: [(&str, &[(&str, &str)], &str); 5] = [
        ("h264_mf", &[("hw_encoding", "1")], "hardware"),
        ("h264_nvenc", &[("preset", "p4")], "hardware"),
        ("h264_mf", &[("hw_encoding", "0")], "software"),
        ("libx264", &[("preset", "veryfast")], "software"),
        ("libopenh264", &[], "software"),
    ];
    let mut errors = Vec::new();
    for (name, options, kind) in attempts {
        let Some(codec) = encoder::find_by_name(name) else {
            continue;
        };
        let mut context = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .map_err(|e| e.to_string())?;
        context.set_width(width);
        context.set_height(height);
        context.set_format(format::Pixel::NV12);
        context.set_aspect_ratio((1, 1));
        context.set_time_base(rate.invert());
        context.set_frame_rate(Some(rate));
        context.set_bit_rate(bit_rate);
        context.set_max_b_frames(0);
        context.set_gop((fps * 2.0).round() as u32);
        context.set_flags(codec::Flags::GLOBAL_HEADER);
        let mut dictionary = ffmpeg::Dictionary::new();
        for (key, value) in options {
            dictionary.set(key, value);
        }
        match context.open_as_with(codec, dictionary) {
            Ok(opened) => {
                let mut stream = output.add_stream(codec).map_err(|e| e.to_string())?;
                stream.set_time_base(rate.invert());
                stream.set_parameters(&opened);
                return Ok((opened, stream.index(), format!("{name} ({kind})")));
            }
            Err(error) => errors.push(format!("{name}: {error}")),
        }
    }
    Err(format!(
        "No H.264 encoder could start ({}).",
        errors.join("; ")
    ))
}

/// Renders `spec` to an MP4 at `output_path` (written to a temporary file first).
pub fn render_draft(
    spec: &DraftRenderSpec,
    output_path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<DraftRenderSummary, String> {
    ffmpeg::init().map_err(|e| e.to_string())?;
    if spec.duration_sec <= 0.0 || spec.video.is_empty() {
        return Err("The draft is empty.".into());
    }
    let width = (spec.width.max(2) / 2 * 2) as usize;
    let height = (spec.height.max(2) / 2 * 2) as usize;
    let rate = frame_rate(spec.fps);
    let fps = rate.numerator() as f64 / rate.denominator() as f64;
    let partial = output_path.with_extension("rendering.mp4");
    let result = (|| -> Result<DraftRenderSummary, String> {
        let mut output =
            format::output(&partial).map_err(|e| format!("Cannot create the video file: {e}"))?;
        let (mut video_encoder, video_index, encoder_name) =
            open_video_encoder(width as u32, height as u32, rate, &mut output)?;
        let audio_codec = encoder::find(codec::Id::AAC).ok_or("The AAC encoder is unavailable")?;
        let mut audio_context = codec::context::Context::new_with_codec(audio_codec)
            .encoder()
            .audio()
            .map_err(|e| e.to_string())?;
        audio_context.set_channel_layout(ffmpeg::ChannelLayout::STEREO);
        audio_context.set_rate(SAMPLE_RATE);
        audio_context.set_format(format::Sample::F32(format::sample::Type::Planar));
        audio_context.set_time_base((1, SAMPLE_RATE));
        audio_context.set_bit_rate(192_000);
        audio_context.set_flags(codec::Flags::GLOBAL_HEADER);
        let mut audio_encoder = audio_context
            .open_as(audio_codec)
            .map_err(|e| e.to_string())?;
        let audio_index = {
            let mut stream = output.add_stream(audio_codec).map_err(|e| e.to_string())?;
            stream.set_time_base((1, SAMPLE_RATE));
            stream.set_parameters(&audio_encoder);
            stream.index()
        };
        let frame_size = audio_encoder.frame_size().max(1) as usize;
        output
            .write_header()
            .map_err(|e| format!("Cannot write the video file: {e}"))?;

        let mut captions = Vec::new();
        for caption in &spec.captions {
            if let Some(overlay) = CaptionOverlay::new(caption, width, height)? {
                captions.push(overlay);
            }
        }
        let mut sound = AudioTimeline::new(spec.audio.clone());
        let mut audio_written: u64 = 0;
        let mut main: Option<(usize, ClipReader)> = None;
        let mut broll: Option<(usize, ClipReader)> = None;
        let total = (spec.duration_sec * fps).ceil() as u64;
        let video_tb = rate.invert();
        let mut out_frame = frame::Video::new(format::Pixel::NV12, width as u32, height as u32);
        let clip_at = |clips: &[DraftClip], t: f64| {
            clips
                .iter()
                .position(|c| t >= c.start_sec - 1e-6 && t < c.end_sec() - 1e-6)
        };

        let mut encode_audio = |sound: &mut AudioTimeline,
                                until: f64,
                                flush: bool,
                                output: &mut format::context::Output,
                                audio_written: &mut u64,
                                audio_encoder: &mut encoder::Audio|
         -> Result<(), String> {
            sound.fill_until(until)?;
            while sound.left.len() >= frame_size || (flush && !sound.left.is_empty()) {
                let n = sound.left.len().min(frame_size);
                let mut frame = frame::Audio::new(
                    format::Sample::F32(format::sample::Type::Planar),
                    n,
                    ffmpeg::ChannelLayout::STEREO,
                );
                frame.set_rate(SAMPLE_RATE as u32);
                frame.plane_mut::<f32>(0)[..n].copy_from_slice(&sound.left[..n]);
                frame.plane_mut::<f32>(1)[..n].copy_from_slice(&sound.right[..n]);
                sound.left.drain(..n);
                sound.right.drain(..n);
                frame.set_pts(Some(*audio_written as i64));
                *audio_written += n as u64;
                audio_encoder
                    .send_frame(&frame)
                    .map_err(|e| e.to_string())?;
                drain_packets(audio_encoder, audio_index, Rational(1, SAMPLE_RATE), output)?;
            }
            Ok(())
        };

        for n in 0..total {
            check_cancel(cancel)?;
            let t = n as f64 / fps;
            let mut picture = Picture::black(width, height);
            if let Some(index) = clip_at(&spec.video, t) {
                if main.as_ref().map(|(i, _)| *i) != Some(index) {
                    let clip = &spec.video[index];
                    main = Some((
                        index,
                        ClipReader::open(&clip.path, clip.in_sec, width, height)?,
                    ));
                }
                let clip = &spec.video[index];
                if let Some(frame) = main
                    .as_mut()
                    .unwrap()
                    .1
                    .frame_at(clip.in_sec + (t - clip.start_sec))?
                {
                    picture = frame.clone();
                }
            } else {
                main = None;
            }
            if let Some(index) = clip_at(&spec.broll, t) {
                if broll.as_ref().map(|(i, _)| *i) != Some(index) {
                    let clip = &spec.broll[index];
                    broll = Some((
                        index,
                        ClipReader::open(&clip.path, clip.in_sec, width, height)?,
                    ));
                }
                let clip = &spec.broll[index];
                let local = t - clip.start_sec;
                let length = clip.out_sec - clip.in_sec;
                let alpha = (local / BROLL_FADE_SEC)
                    .min((length - local) / BROLL_FADE_SEC)
                    .clamp(0.0, 1.0) as f32;
                if let Some(frame) = broll.as_mut().unwrap().1.frame_at(clip.in_sec + local)? {
                    picture.blend(frame, alpha);
                }
            } else {
                broll = None;
            }
            for caption in captions.iter().filter(|c| t >= c.start && t < c.end) {
                caption.draw(&mut picture, width);
            }
            // Into the encoder's frame (respecting its line strides).
            let y_stride = out_frame.stride(0);
            let uv_stride = out_frame.stride(1);
            for row in 0..height {
                out_frame.data_mut(0)[row * y_stride..row * y_stride + width]
                    .copy_from_slice(&picture.y[row * width..(row + 1) * width]);
            }
            for row in 0..height / 2 {
                out_frame.data_mut(1)[row * uv_stride..row * uv_stride + width]
                    .copy_from_slice(&picture.uv[row * width..(row + 1) * width]);
            }
            out_frame.set_pts(Some(n as i64));
            video_encoder
                .send_frame(&out_frame)
                .map_err(|e| e.to_string())?;
            drain_packets(&mut video_encoder, video_index, video_tb, &mut output)?;
            // Keep the sound in step (every half second of picture).
            if n % ((fps / 2.0).round().max(1.0) as u64) == 0 {
                encode_audio(
                    &mut sound,
                    t,
                    false,
                    &mut output,
                    &mut audio_written,
                    &mut audio_encoder,
                )?;
                progress((t / spec.duration_sec).min(0.99));
            }
        }
        encode_audio(
            &mut sound,
            spec.duration_sec,
            true,
            &mut output,
            &mut audio_written,
            &mut audio_encoder,
        )?;
        video_encoder.send_eof().map_err(|e| e.to_string())?;
        drain_packets(&mut video_encoder, video_index, video_tb, &mut output)?;
        audio_encoder.send_eof().map_err(|e| e.to_string())?;
        drain_packets(
            &mut audio_encoder,
            audio_index,
            Rational(1, SAMPLE_RATE),
            &mut output,
        )?;
        output.write_trailer().map_err(|e| e.to_string())?;
        Ok(DraftRenderSummary {
            encoder: encoder_name,
            frames: total,
        })
    })();
    match result {
        Ok(summary) => {
            std::fs::rename(&partial, output_path)
                .map_err(|e| format!("Cannot save the video: {e}"))?;
            progress(1.0);
            Ok(summary)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            Err(error)
        }
    }
}
