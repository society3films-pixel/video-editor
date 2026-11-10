import {
  AudioBufferSink,
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type StreamTargetChunk,
} from "mediabunny";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import { EncodeBackpressure } from "../lib/media/encode-backpressure.util";
import { assertExportAudioSupported, exportAudioConfig } from "../lib/media/video-frame-effect-audio.util";
import { drawClipEditOverlays, punchInRect } from "./clip-edit-draw.util";
import { getFadeFactor, getOutputDuration, type ClipEdit } from "./clip-edit.util";

export interface RenderClipEditOptions {
  /** Stream the MP4 straight to disk. Omit to render into memory. */
  outputSink?: WritableStream<StreamTargetChunk>;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export type RenderClipEditResult =
  | { kind: "disk"; width: number; height: number }
  | { kind: "memory"; blob: Blob; width: number; height: number };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Edit render aborted", "AbortError");
}

/** Even dimensions keep H.264 encoders happy. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Re-encodes an exported clip with the editor's cuts, volume, fades and text overlays applied.
 * Frame-accurate: every kept frame is decoded, composited on a canvas and encoded again.
 */
export async function renderClipEdit(
  file: File,
  edit: ClipEdit,
  options: RenderClipEditOptions = {},
): Promise<RenderClipEditResult> {
  const { outputSink, signal, onProgress } = options;
  throwIfAborted(signal);

  const segments = edit.segments.filter((segment) => segment.end - segment.start > 0.001);
  const outputDuration = getOutputDuration(segments);
  if (segments.length === 0 || outputDuration <= 0) {
    throw new Error("Nothing to render. Keep at least one part of the clip.");
  }

  const input = await createMediabunnyInput(file);
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("The export has no video track.");
    const audioTrack = await input.getPrimaryAudioTrack();

    const width = even(videoTrack.displayWidth);
    const height = even(videoTrack.displayHeight);

    const target = outputSink ? new StreamTarget(outputSink, { chunked: true }) : new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: outputSink ? false : "in-memory" }),
      target,
    });

    const videoSource = new VideoSampleSource({
      codec: "avc",
      bitrate: QUALITY_HIGH,
    });
    output.addVideoTrack(videoSource);

    let audioSource: AudioSampleSource | null = null;
    if (audioTrack && (await audioTrack.canDecode())) {
      await assertExportAudioSupported(audioTrack.numberOfChannels);
      audioSource = new AudioSampleSource(exportAudioConfig(audioTrack.numberOfChannels));
      output.addAudioTrack(audioSource);
    }

    const onAbort = () => void output.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });

    const processVideo = async (): Promise<void> => {
      const sink = new VideoSampleSink(videoTrack);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not create a canvas for rendering.");
      const backpressure = new EncodeBackpressure();
      const frameStep = 1 / 30;

      let offset = 0;
      let lastTimestamp = -Infinity;
      for (const segment of segments) {
        for await (const sample of sink.samples(segment.start, segment.end)) {
          try {
            throwIfAborted(signal);
            const rawEnd = sample.timestamp + (sample.duration || frameStep);
            const visibleStart = Math.max(sample.timestamp, segment.start);
            const visibleEnd = Math.min(rawEnd, segment.end);
            if (visibleEnd - visibleStart <= 1e-4) continue;

            let timestamp = offset + (visibleStart - segment.start);
            if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1e-3;
            const duration = Math.max(1e-3, visibleEnd - visibleStart);
            lastTimestamp = timestamp;

            ctx.clearRect(0, 0, width, height);
            const zoom = segment.zoom ?? 1;
            if (zoom > 1) {
              const rect = punchInRect(width, height, zoom);
              sample.draw(ctx, rect.x, rect.y, rect.width, rect.height);
            } else {
              sample.draw(ctx, 0, 0, width, height);
            }
            drawClipEditOverlays(ctx, edit, timestamp, outputDuration, width, height);

            const outSample = new VideoSample(canvas, { timestamp, duration });
            try {
              await backpressure.run(() => videoSource.add(outSample));
            } finally {
              outSample.close();
            }
            onProgress?.(Math.min(0.99, timestamp / outputDuration));
          } finally {
            sample.close();
          }
        }
        offset += segment.end - segment.start;
      }
      videoSource.close();
    };

    const processAudio = async (): Promise<void> => {
      if (!audioTrack || !audioSource) return;
      const sink = new AudioBufferSink(audioTrack);
      let writtenFrames = 0;
      let outputSampleRate = 0;

      let offset = 0;
      for (const segment of segments) {
        for await (const wrapped of sink.buffers(segment.start, segment.end)) {
          throwIfAborted(signal);
          const { buffer, timestamp } = wrapped;
          const sampleRate = buffer.sampleRate;
          if (!outputSampleRate) outputSampleRate = sampleRate;
          const from = Math.max(0, Math.round((segment.start - timestamp) * sampleRate));
          const to = Math.min(buffer.length, Math.round((segment.end - timestamp) * sampleRate));
          const frameCount = to - from;
          if (frameCount <= 0) continue;

          const channels = buffer.numberOfChannels;
          const planar = new Float32Array(frameCount * channels);
          const firstOutputTime = offset + (timestamp + from / sampleRate - segment.start);
          const needsGain = edit.volume !== 1 || edit.fadeInSec > 0 || edit.fadeOutSec > 0;

          for (let channel = 0; channel < channels; channel++) {
            const source = buffer.getChannelData(channel).subarray(from, to);
            const dest = planar.subarray(channel * frameCount, (channel + 1) * frameCount);
            if (!needsGain) {
              dest.set(source);
              continue;
            }
            for (let i = 0; i < frameCount; i++) {
              const t = firstOutputTime + i / sampleRate;
              const gain = edit.volume * getFadeFactor(edit, t, outputDuration);
              dest[i] = Math.max(-1, Math.min(1, source[i] * gain));
            }
          }

          // Audio stays contiguous across cuts: timestamps follow the frames already written.
          const audioSample = new AudioSample({
            data: planar,
            format: "f32-planar",
            numberOfChannels: channels,
            sampleRate,
            timestamp: writtenFrames / outputSampleRate,
          });
          try {
            await audioSource.add(audioSample);
          } finally {
            audioSample.close();
          }
          writtenFrames += frameCount;
        }
        offset += segment.end - segment.start;
      }
      audioSource.close();
    };

    try {
      await output.start();
      const results = await Promise.allSettled([processVideo(), processAudio()]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
      throwIfAborted(signal);
      await output.finalize();
      onProgress?.(1);
    } catch (error) {
      if (output.state !== "finalized" && output.state !== "canceled") {
        await output.cancel().catch(() => {});
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    if (outputSink) return { kind: "disk", width, height };
    const buffer = (target as BufferTarget).buffer;
    if (!buffer) throw new Error("Render produced no output.");
    return { kind: "memory", blob: new Blob([buffer], { type: "video/mp4" }), width, height };
  } finally {
    input.dispose();
  }
}
