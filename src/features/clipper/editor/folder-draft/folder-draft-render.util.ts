/**
 * Renders a folder draft timeline to an MP4 in the app: V1 camera cuts, V2 B-roll over them,
 * A1 sound (the recorder where it covers), optional burned-in captions.
 */
import {
  AudioBufferSink,
  AudioSample,
  AudioSampleSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type Input,
  type StreamTargetChunk,
} from "mediabunny";
import { createMediabunnyInput } from "../../lib/media/mediabunny-file-source.util";
import { EncodeBackpressure } from "../../lib/media/encode-backpressure.util";
import {
  assertExportAudioSupported,
  exportAudioConfig,
} from "../../lib/media/video-frame-effect-audio.util";
import {
  fileFor,
  type DraftTimeline,
  type TimelineClip,
} from "./folder-draft.util";

export interface DraftCaption {
  start: number;
  end: number;
  text: string;
}

const SAMPLE_RATE = 48000;
const EDGE_FADE_SEC = 0.012;

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Reads one timeline clip's frames in order, holding the latest frame at or before a time. */
class ClipFrames {
  private iterator: AsyncIterator<VideoSample> | null = null;
  private current: VideoSample | null = null;
  private upcoming: VideoSample | null = null;
  private done = false;

  constructor(
    private readonly sink: VideoSampleSink,
    readonly clip: TimelineClip,
  ) {}

  async at(sourceTime: number): Promise<VideoSample | null> {
    this.iterator ??= this.sink
      .samples(Math.max(0, this.clip.inSec), this.clip.outSec + 0.5)
      [Symbol.asyncIterator]();
    for (;;) {
      if (!this.upcoming && !this.done) {
        const next = await this.iterator.next();
        if (next.done) this.done = true;
        else this.upcoming = next.value;
      }
      if (!this.upcoming || this.upcoming.timestamp > sourceTime + 1e-4) break;
      this.current?.close();
      this.current = this.upcoming;
      this.upcoming = null;
    }
    return this.current;
  }

  dispose(): void {
    this.current?.close();
    this.upcoming?.close();
    void this.iterator?.return?.();
  }
}

/** One open file per path, shared by its clips. */
class Inputs {
  private readonly inputs = new Map<string, Promise<Input>>();
  get(clip: TimelineClip): Promise<Input> {
    let input = this.inputs.get(clip.media.path);
    if (!input) {
      input = createMediabunnyInput(fileFor(clip.media));
      this.inputs.set(clip.media.path, input);
    }
    return input;
  }
  async dispose(): Promise<void> {
    for (const input of this.inputs.values())
      (await input.catch(() => null))?.dispose();
  }
}

function clipAt(
  clips: readonly TimelineClip[],
  t: number,
): TimelineClip | null {
  for (const clip of clips)
    if (t >= clip.startSec && t < clip.startSec + (clip.outSec - clip.inSec))
      return clip;
  return null;
}

/** Draws a frame to fit inside the output (black bars when the shape differs a lot, else fills). */
function drawFitted(
  ctx: OffscreenCanvasRenderingContext2D,
  sample: VideoSample,
  width: number,
  height: number,
  alpha = 1,
): void {
  const sw = sample.displayWidth;
  const sh = sample.displayHeight;
  const cover = Math.max(width / sw, height / sh);
  const contain = Math.min(width / sw, height / sh);
  // Fill when it only crops a little (e.g. 4K DCI into 16:9), else fit.
  const scale = cover / contain < 1.15 ? cover : contain;
  const w = sw * scale;
  const h = sh * scale;
  ctx.globalAlpha = alpha;
  sample.draw(ctx, (width - w) / 2, (height - h) / 2, w, h);
  ctx.globalAlpha = 1;
}

/** How a caption is laid out on a frame: up to two lines above the bottom edge. */
function captionLayout(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
) {
  const size = Math.round(height * 0.045);
  ctx.font = `700 ${size}px Inter, "Segoe UI", Arial, sans-serif`;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width * 0.8 && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  const shown = lines.slice(-2);
  return {
    size,
    stroke: Math.max(2, size * 0.16),
    lines: shown.map((l, i) => ({
      text: l,
      y: height * 0.92 - (shown.length - 1 - i) * size * 1.2,
      width: ctx.measureText(l).width,
    })),
  };
}

function drawCaption(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
): void {
  const layout = captionLayout(ctx, text, width, height);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  ctx.lineWidth = layout.stroke;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.fillStyle = "#fff";
  for (const l of layout.lines) {
    ctx.strokeText(l.text, width / 2, l.y);
    ctx.fillText(l.text, width / 2, l.y);
  }
}

/** A caption drawn on a small transparent image, and where it goes on the frame (for the native render). */
export async function captionImage(
  text: string,
  width: number,
  height: number,
): Promise<{ x: number; y: number; pngBase64: string } | null> {
  const scratch = new OffscreenCanvas(1, 1).getContext("2d");
  if (!scratch) return null;
  const layout = captionLayout(scratch, text, width, height);
  if (!layout.lines.length) return null;
  const pad = Math.ceil(layout.stroke) + 2;
  const widest = Math.max(...layout.lines.map((l) => l.width));
  const x0 = Math.max(0, Math.floor(width / 2 - widest / 2 - pad));
  const x1 = Math.min(width, Math.ceil(width / 2 + widest / 2 + pad));
  const y0 = Math.max(
    0,
    Math.floor(
      Math.min(...layout.lines.map((l) => l.y)) - layout.size * 1.15 - pad,
    ),
  );
  const y1 = Math.min(
    height,
    Math.ceil(Math.max(...layout.lines.map((l) => l.y)) + pad),
  );
  const canvas = new OffscreenCanvas(
    Math.max(2, x1 - x0),
    Math.max(2, y1 - y0),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.translate(-x0, -y0);
  drawCaption(ctx, text, width, height);
  const bytes = new Uint8Array(
    await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { x: x0, y: y0, pngBase64: btoa(binary) };
}

export async function renderDraftTimeline(
  timeline: DraftTimeline,
  options: {
    width: number;
    height: number;
    fps: number;
    /** Smaller output renders faster (e.g. 1080 from 4K cameras, or 720 for a quick look). */
    maxHeight?: number;
    captions?: readonly DraftCaption[];
    outputSink: WritableStream<StreamTargetChunk>;
    signal?: AbortSignal;
    onProgress?: (ratio: number) => void;
  },
): Promise<void> {
  const { signal, onProgress } = options;
  const scale =
    options.maxHeight && options.height > options.maxHeight
      ? options.maxHeight / options.height
      : 1;
  const width = even(options.width * scale);
  const height = even(options.height * scale);
  const fps = Math.min(60, Math.max(12, options.fps || 30));
  const duration = timeline.durationSec;
  if (duration <= 0) throw new Error("The draft is empty.");
  await assertExportAudioSupported(2);

  const inputs = new Inputs();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(options.outputSink, { chunked: true }),
  });
  const videoSource = new VideoSampleSource({
    codec: "avc",
    bitrate: QUALITY_HIGH,
    // The graphics card's encoder (NVENC and the like) when there is one: much faster.
    hardwareAcceleration: "prefer-hardware",
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = new AudioSampleSource(exportAudioConfig(2));
  output.addAudioTrack(audioSource);
  const onAbort = () => void output.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  const readers = new Map<TimelineClip, ClipFrames>();
  const readerFor = async (clip: TimelineClip): Promise<ClipFrames | null> => {
    let reader = readers.get(clip);
    if (!reader) {
      const track = await (await inputs.get(clip)).getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return null;
      reader = new ClipFrames(new VideoSampleSink(track), clip);
      readers.set(clip, reader);
    }
    return reader;
  };
  const release = (keep: Array<TimelineClip | null>) => {
    for (const [clip, reader] of readers) {
      if (keep.includes(clip)) continue;
      reader.dispose();
      readers.delete(clip);
    }
  };

  const processVideo = async () => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a canvas for rendering.");
    const backpressure = new EncodeBackpressure();
    const total = Math.ceil(duration * fps);
    for (let frame = 0; frame < total; frame++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const t = frame / fps;
      const main = clipAt(timeline.video, t);
      const broll = clipAt(timeline.broll, t);
      release([main, broll]);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      if (main) {
        const sample = await (
          await readerFor(main)
        )?.at(main.inSec + (t - main.startSec));
        if (sample) drawFitted(ctx, sample, width, height);
      }
      if (broll) {
        const local = t - broll.startSec;
        const length = broll.outSec - broll.inSec;
        const fade = Math.max(
          0,
          Math.min(1, local / 0.2, (length - local) / 0.2),
        );
        const sample = await (await readerFor(broll))?.at(broll.inSec + local);
        if (sample) drawFitted(ctx, sample, width, height, fade);
      }
      const caption = options.captions?.find((c) => t >= c.start && t < c.end);
      if (caption) drawCaption(ctx, caption.text, width, height);
      const sample = new VideoSample(canvas, {
        timestamp: t,
        duration: 1 / fps,
      });
      try {
        await backpressure.run(() => videoSource.add(sample));
      } finally {
        sample.close();
      }
      if (frame % 15 === 0) onProgress?.(Math.min(0.99, t / duration));
    }
    release([]);
    videoSource.close();
  };

  const processAudio = async () => {
    let written = 0; // seconds
    const writeSilence = async (until: number) => {
      while (written < until - 1e-6) {
        const frames = Math.min(
          SAMPLE_RATE,
          Math.round((until - written) * SAMPLE_RATE),
        );
        if (frames <= 0) break;
        const sample = new AudioSample({
          data: new Float32Array(frames * 2),
          format: "f32-planar",
          numberOfChannels: 2,
          sampleRate: SAMPLE_RATE,
          timestamp: written,
        });
        try {
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
        written += frames / SAMPLE_RATE;
      }
    };
    const clips = [...timeline.audio].sort((a, b) => a.startSec - b.startSec);
    for (const clip of clips) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await writeSilence(clip.startSec);
      const end = clip.startSec + (clip.outSec - clip.inSec);
      if (written >= end) continue;
      const track = await (await inputs.get(clip)).getPrimaryAudioTrack();
      if (track && (await track.canDecode())) {
        // A clip that starts before the file does (negative in-point): silence first.
        if (clip.inSec < 0) await writeSilence(clip.startSec - clip.inSec);
        const from = Math.max(0, clip.inSec);
        for await (const { buffer, timestamp } of new AudioBufferSink(
          track,
        ).buffers(from, clip.outSec)) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const rate = buffer.sampleRate;
          // Where this buffer lands on the timeline, picking up exactly where the audio stops.
          const sourceAtWritten = clip.inSec + (written - clip.startSec);
          const first = Math.max(
            0,
            Math.round((sourceAtWritten - timestamp) * rate),
          );
          const last = Math.min(
            buffer.length,
            Math.round((clip.outSec - timestamp) * rate),
          );
          const count = last - first;
          if (count <= 0) continue;
          const left = buffer.getChannelData(0);
          const right =
            buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
          const data = new Float32Array(count * 2);
          for (let i = 0; i < count; i++) {
            const source = timestamp + (first + i) / rate;
            const edge = Math.min(
              1,
              (source - clip.inSec) / EDGE_FADE_SEC,
              (clip.outSec - source) / EDGE_FADE_SEC,
            );
            const g = Math.max(0, edge);
            data[i] = left[first + i]! * g;
            data[count + i] = right[first + i]! * g;
          }
          const sample = new AudioSample({
            data,
            format: "f32-planar",
            numberOfChannels: 2,
            sampleRate: rate,
            timestamp: written,
          });
          try {
            await audioSource.add(sample);
          } finally {
            sample.close();
          }
          written += count / rate;
        }
      }
      await writeSilence(end);
    }
    await writeSilence(duration);
    audioSource.close();
  };

  try {
    await output.start();
    const results = await Promise.allSettled([processVideo(), processAudio()]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
    await output.finalize();
    onProgress?.(1);
  } catch (error) {
    if (output.state !== "finalized" && output.state !== "canceled")
      await output.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    for (const reader of readers.values()) reader.dispose();
    await inputs.dispose();
  }
}
