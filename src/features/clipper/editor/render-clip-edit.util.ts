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
import { drawClipEditOverlays, drawCoverTitle, punchInRect } from "./clip-edit-draw.util";
import { COVER_FIRST_FRAMES_SEC, getFadeFactor, getOutputDuration, soundEffectsActive, type ClipEdit } from "./clip-edit.util";
import { createAudioExtrasMixer, decodeAudioFile, soundEffectEvents, type DecodedAudio } from "./audio-extras.util";
import { loadEditorAsset } from "./editor-assets.util";
import { hookDuration, renderSegmentsFor } from "./hook.util";
import { activeInserts, loadInsertMedia } from "./broll.util";

export interface RenderClipEditOptions {
  /** Stream the MP4 straight to disk. Omit to render into memory. */
  outputSink?: WritableStream<StreamTargetChunk>;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export type RenderClipEditResult = (
  | { kind: "disk"; width: number; height: number }
  | { kind: "memory"; blob: Blob; width: number; height: number }
) & {
  /** PNG of the cover frame when the edit has a cover. */
  cover?: Blob;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Edit render aborted", "AbortError");
}

/** Even dimensions keep H.264 encoders happy. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function drawFrame(ctx: OffscreenCanvasRenderingContext2D, sample: VideoSample, zoom: number): void {
  const { width, height } = ctx.canvas;
  if (zoom > 1) {
    const rect = punchInRect(width, height, zoom);
    sample.draw(ctx, rect.x, rect.y, rect.width, rect.height);
  } else {
    sample.draw(ctx, 0, 0, width, height);
  }
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

  const mainSegments = edit.segments.filter((segment) => segment.end - segment.start > 0.001);
  // The hook (if any) plays first; everything else is timed after it.
  const segments = renderSegmentsFor(edit);
  const hookLength = segments[0]?.id === "hook" ? hookDuration(edit) : 0;
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

    let music: DecodedAudio | null = null;
    if (edit.music && audioSource) {
      const musicFile = await loadEditorAsset(edit.music.assetId);
      if (!musicFile) throw new Error(`The music file "${edit.music.name}" is no longer saved on this computer. Pick it again in the Audio section.`);
      music = await decodeAudioFile(musicFile, edit.music.startSec, outputDuration + 1);
    }
    const effects = soundEffectsActive(edit) && edit.sfx ? { events: soundEffectEvents(segments, edit.sfx), volume: edit.sfx.volume } : null;
    const hasExtras = Boolean(music) || Boolean(effects?.events.length);

    // Cover: the frame at the cover time with this edit's zoom and overlays, plus its title.
    let coverCanvas: OffscreenCanvas | null = null;
    if (edit.cover) {
      const mainDuration = getOutputDuration(mainSegments);
      const coverTime = Math.min(Math.max(0, edit.cover.time), Math.max(0, mainDuration - 0.01));
      let offset = 0;
      let segment = mainSegments[mainSegments.length - 1]!;
      let sourceTime = segment.end - 0.01;
      for (const candidate of mainSegments) {
        const length = candidate.end - candidate.start;
        if (coverTime < offset + length) {
          segment = candidate;
          sourceTime = candidate.start + (coverTime - offset);
          break;
        }
        offset += length;
      }
      const sample = await new VideoSampleSink(videoTrack).getSample(sourceTime);
      if (sample) {
        try {
          coverCanvas = new OffscreenCanvas(width, height);
          const coverCtx = coverCanvas.getContext("2d")!;
          drawFrame(coverCtx, sample, segment.zoom ?? 1);
          drawClipEditOverlays(coverCtx, { ...edit, fadeInSec: 0, fadeOutSec: 0, progressBar: null }, coverTime, mainDuration, width, height);
          drawCoverTitle(coverCtx, edit.cover.title, width, height);
        } finally {
          sample.close();
        }
      }
    }
    const coverFirstFrames = coverCanvas && edit.cover?.firstFrames ? coverCanvas : null;
    const insertMedia = edit.inserts?.length ? await loadInsertMedia(edit.inserts) : null;

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
            if (coverFirstFrames && timestamp < COVER_FIRST_FRAMES_SEC) {
              ctx.drawImage(coverFirstFrames, 0, 0);
            } else {
              drawFrame(ctx, sample, segment.zoom ?? 1);
              const textTime = timestamp - hookLength;
              const insertFrames = new Map<string, { media: CanvasImageSource; width: number; height: number } | null>();
              if (insertMedia) {
                for (const insert of activeInserts(edit.inserts, textTime)) {
                  insertFrames.set(insert.id, await insertMedia.frameFor(insert, textTime - insert.start));
                }
              }
              drawClipEditOverlays(ctx, edit, timestamp, outputDuration, width, height, {
                textTime,
                insertFrame: (insert) => insertFrames.get(insert.id) ?? null,
              });
            }

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
      let mixExtras: ReturnType<typeof createAudioExtrasMixer> | null = null;

      let offset = 0;
      for (const segment of segments) {
        for await (const wrapped of sink.buffers(segment.start, segment.end)) {
          throwIfAborted(signal);
          const { buffer, timestamp } = wrapped;
          const sampleRate = buffer.sampleRate;
          if (!outputSampleRate) outputSampleRate = sampleRate;
          if (hasExtras && !mixExtras) {
            mixExtras = createAudioExtrasMixer(
              {
                outputDuration,
                fades: edit,
                music: music && edit.music ? { audio: music, volume: edit.music.volume, duck: edit.music.duck } : null,
                effects,
              },
              sampleRate,
            );
          }
          const from = Math.max(0, Math.round((segment.start - timestamp) * sampleRate));
          const to = Math.min(buffer.length, Math.round((segment.end - timestamp) * sampleRate));
          const frameCount = to - from;
          if (frameCount <= 0) continue;

          const channels = buffer.numberOfChannels;
          const planar = new Float32Array(frameCount * channels);
          const firstOutputTime = offset + (timestamp + from / sampleRate - segment.start);
          const needsGain = edit.volume !== 1 || edit.fadeInSec > 0 || edit.fadeOutSec > 0 || Boolean(edit.bleeps?.length);
          const bufferStart = timestamp + from / sampleRate;

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
              const sourceTime = bufferStart + i / sampleRate;
              const bleeped = edit.bleeps?.some((range) => sourceTime >= range.start && sourceTime < range.end);
              const value = bleeped ? Math.sin(2 * Math.PI * 1000 * sourceTime) * 0.3 : source[i];
              dest[i] = Math.max(-1, Math.min(1, value * gain));
            }
          }

          mixExtras?.(planar, channels, frameCount, firstOutputTime);

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
      insertMedia?.dispose();
    }

    const cover = coverCanvas ? await coverCanvas.convertToBlob({ type: "image/png" }) : undefined;
    if (outputSink) return { kind: "disk", width, height, cover };
    const buffer = (target as BufferTarget).buffer;
    if (!buffer) throw new Error("Render produced no output.");
    return { kind: "memory", blob: new Blob([buffer], { type: "video/mp4" }), width, height, cover };
  } finally {
    input.dispose();
  }
}
