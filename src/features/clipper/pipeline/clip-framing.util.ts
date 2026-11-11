import type { ClipperGeneratedClip } from "../engine/segmentation";
import type { ClipperClipSegmentWindow } from "../engine/segmentation/segmentation.types";
import {
  createEmptyFramingTrack,
  isFramingTrackEmpty,
  mergeShotBoundaries,
  type ClipFramingRender,
  type ClipFramingTrack,
} from "../engine/render/framing-override.util";
import { isClipperRuntimeSmartCropBlob, type ClipperFrameAnalysis } from "../shared/smart-crop.util";

/** Clip framing tracks keyed by `clipFramingKey`. */
export type ClipFramingMap = Record<string, ClipFramingTrack>;

/**
 * Stable identity for a clip's framing: its source windows. Clip indexes shift when clips are
 * added or deleted, but framing times only make sense for the exact same windows.
 */
export function clipFramingKey(clip: Pick<ClipperGeneratedClip, "segments" | "startSec" | "endSec">): string {
  const segments = clip.segments.length ? clip.segments : [{ startSec: clip.startSec, endSec: clip.endSec }];
  return segments.map((segment) => `${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}`).join("|");
}

const sceneCutCache = new WeakMap<object, number[]>();

/** Scene-cut times (range-source time) from the AI camera track. */
export function analysisSceneCuts(analysis: ClipperFrameAnalysis | null | undefined): number[] {
  if (!analysis) return [];
  const cached = sceneCutCache.get(analysis);
  if (cached) return cached;
  const tracks: Array<{ samples: Array<{ t: number; cut?: boolean }> }> = isClipperRuntimeSmartCropBlob(analysis)
    ? Object.values(analysis.layoutTracks)
    : [...Object.values(analysis.layoutTracks ?? {}), ...Object.values(analysis.aspectTracks ?? {})];
  // Every format's track is cut at the same scene changes; use the one with the most cuts.
  let best: number[] = [];
  for (const track of tracks) {
    const cuts = track.samples.filter((sample) => sample.cut).map((sample) => sample.t);
    if (cuts.length > best.length) best = cuts;
  }
  const sorted = [...new Set(best)].sort((a, b) => a - b);
  sceneCutCache.set(analysis, sorted);
  return sorted;
}

/**
 * Shot boundaries in clip-local time: scene cuts inside the clip's windows, plus the joins
 * between windows of a multi-window clip.
 */
export function clipShotBoundaries(
  segments: readonly ClipperClipSegmentWindow[],
  sceneCuts: readonly number[],
): number[] {
  const local: number[] = [];
  let offset = 0;
  segments.forEach((segment, index) => {
    if (index > 0) local.push(offset);
    for (const cut of sceneCuts) {
      if (cut > segment.startSec + 0.05 && cut < segment.endSec - 0.05) local.push(offset + cut - segment.startSec);
    }
    offset += Math.max(0, segment.endSec - segment.startSec);
  });
  return mergeShotBoundaries(local);
}

export function resolveClipFramingRender(
  framingMap: ClipFramingMap | undefined,
  analysis: ClipperFrameAnalysis | null | undefined,
  clip: ClipperGeneratedClip,
): ClipFramingRender {
  return {
    track: framingMap?.[clipFramingKey(clip)] ?? createEmptyFramingTrack(),
    aiShotBoundaries: clipShotBoundaries(clip.segments, analysisSceneCuts(analysis)),
  };
}

/** Part of the render signature, so exports re-render after framing changes. */
export function clipFramingSignature(framingMap: ClipFramingMap | undefined, clip: ClipperGeneratedClip): unknown {
  const track = framingMap?.[clipFramingKey(clip)];
  if (isFramingTrackEmpty(track)) return null;
  return [
    track!.extraShotBoundaries,
    track!.keyframes.map((k) => [k.t, k.mode, k.x, k.y, k.zoom, k.singleShot, k.split ?? null, k.splitFollow ?? false, k.splitSwap ?? false, k.splitEmphasis ?? false, k.fit ?? null, k.slowZoom ?? 0]),
    track!.speakers ?? null,
  ];
}
