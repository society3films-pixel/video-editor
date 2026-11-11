import type { SpeakerSpan } from "./speaker-emphasis.util";
import type { FrameEffectSize } from "../../lib/media/video-frame-effect.util";
import { cropRectForCentroid } from "../reframe/crop.util";
import type { ClipperCropRect } from "../types/reframe.types";

/** How the camera is framed at one moment. */
export interface ClipperFramingValue {
  /**
   * `auto`: keep following the AI camera path, shifted by `x`/`y` (fractions of the crop size).
   * `fixed`: a locked camera centred on `x`/`y` (0..1 of the source frame).
   */
  mode: "auto" | "fixed";
  x: number;
  y: number;
  /** 1 = AI framing size; 2 = twice as close. */
  zoom: number;
  /** Replace AI split-screen layouts with a single shot. */
  singleShot: boolean;
  /**
   * Force a two-panel split screen with these panels (first = top, or left on landscape
   * outputs). When set, `mode`/`x`/`y`/`zoom`/`singleShot` are ignored.
   */
  split?: ClipperSplitPanel[];
  /** Forced split: each panel follows a person (AI face tracking) instead of a fixed point. */
  splitFollow?: boolean;
  /** AI-tracked split: put the right-hand person in the first panel instead of the left. */
  splitSwap?: boolean;
  /** AI-tracked split: grow the panel of whoever is talking (needs `ClipFramingTrack.speakers`). */
  splitEmphasis?: boolean;
  /**
   * "blur": show the whole source frame (scaled to fit, `zoom` crops in a little) over a blurred,
   * darkened copy that fills the rest. Ignored for split screens.
   */
  fit?: "blur";
  /** Slow push-in over the shot (Ken Burns): 0.1 = 10% closer at the end of the shot than at its start. */
  slowZoom?: number;
}

/** One panel of a forced split screen: a camera centred on `x`/`y` (0..1 of the source). */
export interface ClipperSplitPanel {
  x: number;
  y: number;
  /** 1 = the largest crop of the panel's shape that fits the source. */
  zoom: number;
  /** AI-tracked split only: nudge from the tracked face, as fractions of the panel's crop. */
  dx?: number;
  dy?: number;
}

/** A framing value pinned to a clip-local time. */
export interface ClipFramingKeyframe extends ClipperFramingValue {
  id: string;
  t: number;
}

/**
 * User framing for one clip, in clip-local time (the timeline captions and exports use).
 * Keyframes only affect the shot they sit in: within a shot the camera moves smoothly between
 * keyframes; a shot without keyframes keeps the AI framing. Shots are split at the AI's scene
 * cuts plus `extraShotBoundaries` the user added.
 */
export interface ClipFramingTrack {
  keyframes: ClipFramingKeyframe[];
  extraShotBoundaries: number[];
  /** Who is talking when (clip-local), from mouth movement; used by `splitEmphasis`. */
  speakers?: SpeakerSpan[];
}

/** What the renderer receives: the track plus the AI shot boundaries for this clip. */
export interface ClipFramingRender {
  track: ClipFramingTrack;
  aiShotBoundaries: number[];
}

export const DEFAULT_FRAMING_ZOOM_RANGE = { min: 1, max: 3 } as const;
const BOUNDARY_EPSILON = 1e-3;

export function createEmptyFramingTrack(): ClipFramingTrack {
  return { keyframes: [], extraShotBoundaries: [] };
}

export function isFramingTrackEmpty(track: ClipFramingTrack | null | undefined): boolean {
  return !track || (track.keyframes.length === 0 && track.extraShotBoundaries.length === 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Sorted, de-duplicated shot boundaries (> 0). */
export function mergeShotBoundaries(...lists: ReadonlyArray<readonly number[]>): number[] {
  const all = lists.flat().filter((t) => Number.isFinite(t) && t > BOUNDARY_EPSILON).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of all) {
    if (merged.length === 0 || t - merged[merged.length - 1]! > 0.05) merged.push(t);
  }
  return merged;
}

const boundaryCache = new WeakMap<ClipFramingRender, number[]>();
function shotBoundariesFor(render: ClipFramingRender): number[] {
  let cached = boundaryCache.get(render);
  if (!cached) {
    cached = mergeShotBoundaries(render.aiShotBoundaries, render.track.extraShotBoundaries);
    boundaryCache.set(render, cached);
  }
  return cached;
}

export function shotIndexAt(boundaries: readonly number[], t: number): number {
  let index = 0;
  while (index < boundaries.length && t >= boundaries[index]! - BOUNDARY_EPSILON) index++;
  return index;
}

/** Start and end (clip-local) of the shot containing `t`. */
export function shotRangeAt(boundaries: readonly number[], t: number, duration: number): { index: number; start: number; end: number } {
  const index = shotIndexAt(boundaries, t);
  return {
    index,
    start: index === 0 ? 0 : boundaries[index - 1]!,
    end: index < boundaries.length ? boundaries[index]! : duration,
  };
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function toValue(keyframe: ClipFramingKeyframe): ClipperFramingValue {
  const value: ClipperFramingValue = {
    mode: keyframe.mode,
    x: keyframe.x,
    y: keyframe.y,
    zoom: keyframe.zoom,
    singleShot: keyframe.singleShot,
  };
  if (isForcedSplit(keyframe)) {
    value.split = keyframe.split!.map((panel) => ({ ...panel }));
    if (keyframe.splitFollow) value.splitFollow = true;
    if (keyframe.splitSwap) value.splitSwap = true;
    if (keyframe.splitEmphasis) value.splitEmphasis = true;
  }
  if (keyframe.fit) value.fit = keyframe.fit;
  if (keyframe.slowZoom) value.slowZoom = keyframe.slowZoom;
  return value;
}

export function isForcedSplit(value: Pick<ClipperFramingValue, "split"> | undefined): boolean {
  return Boolean(value?.split && value.split.length >= 2);
}

/** Framing at a clip-local time from keyframes in the same shot, or undefined for AI framing. */
export function evaluateFramingTrack(
  track: ClipFramingTrack,
  boundaries: readonly number[],
  t: number,
): ClipperFramingValue | undefined {
  if (track.keyframes.length === 0) return undefined;
  const shot = shotIndexAt(boundaries, t);
  let previous: ClipFramingKeyframe | undefined;
  let next: ClipFramingKeyframe | undefined;
  for (const keyframe of track.keyframes) {
    if (shotIndexAt(boundaries, keyframe.t) !== shot) continue;
    if (keyframe.t <= t) {
      if (!previous || keyframe.t >= previous.t) previous = keyframe;
    } else if (!next || keyframe.t < next.t) {
      next = keyframe;
    }
  }
  if (!previous && !next) return undefined;
  if (!previous) return toValue(next!);
  if (
    !next ||
    next.t - previous.t < 1e-6 ||
    isForcedSplit(next) !== isForcedSplit(previous) ||
    Boolean(next.splitFollow) !== Boolean(previous.splitFollow) ||
    (next.fit ?? null) !== (previous.fit ?? null)
  ) {
    return toValue(previous);
  }
  const u = smoothstep(clamp((t - previous.t) / (next.t - previous.t), 0, 1));
  if (isForcedSplit(previous)) {
    return {
      ...toValue(previous),
      split: previous.split!.slice(0, 2).map((panel, index) => {
        const target = next.split![index] ?? panel;
        return {
          x: panel.x + (target.x - panel.x) * u,
          y: panel.y + (target.y - panel.y) * u,
          zoom: panel.zoom + (target.zoom - panel.zoom) * u,
          dx: (panel.dx ?? 0) + ((target.dx ?? 0) - (panel.dx ?? 0)) * u,
          dy: (panel.dy ?? 0) + ((target.dy ?? 0) - (panel.dy ?? 0)) * u,
        };
      }),
    };
  }
  if (next.mode !== previous.mode) return toValue(previous);
  return {
    mode: previous.mode,
    x: previous.x + (next.x - previous.x) * u,
    y: previous.y + (next.y - previous.y) * u,
    zoom: previous.zoom + (next.zoom - previous.zoom) * u,
    singleShot: previous.singleShot,
  };
}

/** Shot (clip-local range) containing `t`, with the user's extra shot changes. */
export function clipShotRangeAt(render: ClipFramingRender, t: number, duration: number) {
  return shotRangeAt(mergeShotBoundaries(render.aiShotBoundaries, render.track.extraShotBoundaries), t, duration);
}

/** Crop narrowed for a slow push-in: `progress` 0..1 through the shot, eased. */
export function slowZoomCrop(crop: ClipperCropRect, amount: number, progress: number, source: FrameEffectSize): ClipperCropRect {
  const u = clamp(progress, 0, 1);
  const factor = 1 + clamp(amount, 0, 0.5) * u * u * (3 - 2 * u);
  const sw = crop.sw / factor;
  const sh = crop.sh / factor;
  // Zoom towards a point a little above centre, where faces usually are.
  const cx = crop.sx + crop.sw / 2;
  const cy = crop.sy + crop.sh * 0.42;
  return {
    sx: clamp(cx - sw / 2, 0, source.width - sw),
    sy: clamp(cy - sh * 0.42, 0, source.height - sh),
    sw,
    sh,
  };
}

/** Whole frame scaled to fit the output, centred; zoom > 1 enlarges it, cropping what spills over. */
export function fitWholeFrame(
  source: FrameEffectSize,
  output: FrameEffectSize,
  zoom: number,
): { source: ClipperCropRect; destination: { x: number; y: number; width: number; height: number } } {
  const scale = Math.min(output.width / source.width, output.height / source.height) * clamp(zoom || 1, 1, 3);
  const width = Math.min(output.width, source.width * scale);
  const height = Math.min(output.height, source.height * scale);
  const sw = width / scale;
  const sh = height / scale;
  return {
    source: { sx: (source.width - sw) / 2, sy: (source.height - sh) / 2, sw, sh },
    destination: { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height },
  };
}

export function evaluateClipFraming(render: ClipFramingRender | undefined, t: number): ClipperFramingValue | undefined {
  if (!render || render.track.keyframes.length === 0) return undefined;
  return evaluateFramingTrack(render.track, shotBoundariesFor(render), t);
}

/** Applies a manual framing value to an AI crop, keeping the output aspect and source bounds. */
export function applyFramingOverride(
  crop: ClipperCropRect,
  framing: ClipperFramingValue,
  source: FrameEffectSize,
  output: FrameEffectSize,
): ClipperCropRect {
  const aspect = output.width / Math.max(1, output.height);
  const zoom = clamp(framing.zoom || 1, DEFAULT_FRAMING_ZOOM_RANGE.min, DEFAULT_FRAMING_ZOOM_RANGE.max);

  let width: number;
  let height: number;
  let centerX: number;
  let centerY: number;
  if (framing.mode === "fixed") {
    const natural = cropRectForCentroid(source.width, source.height, 0.5, 0.5, aspect);
    width = natural.sw / zoom;
    height = natural.sh / zoom;
    centerX = clamp(framing.x, 0, 1) * source.width;
    centerY = clamp(framing.y, 0, 1) * source.height;
  } else {
    width = crop.sw / zoom;
    height = crop.sh / zoom;
    centerX = crop.sx + crop.sw / 2 + clamp(framing.x, -1, 1) * crop.sw;
    centerY = crop.sy + crop.sh / 2 + clamp(framing.y, -1, 1) * crop.sh;
  }

  width = Math.min(width, source.width);
  height = Math.min(height, source.height);
  const sx = clamp(centerX - width / 2, 0, source.width - width);
  const sy = clamp(centerY - height / 2, 0, source.height - height);
  return { sx, sy, sw: width, sh: height };
}

// ---- Forced split screen ---------------------------------------------------------------------

export interface SplitPanelLayout {
  source: ClipperCropRect;
  destination: { x: number; y: number; width: number; height: number };
}

function evenFloor(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Where the two panels go: stacked on portrait/square outputs, side by side on landscape. */
export function forcedSplitDestinations(output: FrameEffectSize, firstShare = 0.5): SplitPanelLayout["destination"][] {
  if (output.width > output.height) {
    const left = evenFloor(output.width * firstShare);
    return [
      { x: 0, y: 0, width: left, height: output.height },
      { x: left, y: 0, width: output.width - left, height: output.height },
    ];
  }
  const top = evenFloor(output.height * firstShare);
  return [
    { x: 0, y: 0, width: output.width, height: top },
    { x: 0, y: top, width: output.width, height: output.height - top },
  ];
}

/** Index of the panel under a point in output pixels. */
export function splitPanelIndexAt(output: FrameEffectSize, x: number, y: number): number {
  return output.width > output.height ? (x < output.width / 2 ? 0 : 1) : (y < output.height / 2 ? 0 : 1);
}

/** Crop for one panel: the panel's shape, centred on the panel's point, zoomed in from max size. */
export function splitPanelCrop(
  panel: ClipperSplitPanel,
  destination: SplitPanelLayout["destination"],
  source: FrameEffectSize,
): ClipperCropRect {
  const aspect = destination.width / Math.max(1, destination.height);
  const natural = cropRectForCentroid(source.width, source.height, 0.5, 0.5, aspect);
  const zoom = clamp(panel.zoom || 1, DEFAULT_FRAMING_ZOOM_RANGE.min, DEFAULT_FRAMING_ZOOM_RANGE.max);
  const width = Math.min(natural.sw / zoom, source.width);
  const height = Math.min(natural.sh / zoom, source.height);
  const sx = clamp(clamp(panel.x, 0, 1) * source.width - width / 2, 0, source.width - width);
  const sy = clamp(clamp(panel.y, 0, 1) * source.height - height / 2, 0, source.height - height);
  return { sx, sy, sw: width, sh: height };
}

/** Tracked face centre (0..1 of the source) for each panel; null = no tracking, use the panel's point. */
export type SplitPanelFaces = Array<{ x: number; y: number } | null>;

/** Share of the panel's crop height the face sits above centre (head-and-shoulders framing). */
const TRACKED_FACE_HEADROOM = 0.12;

export function forcedSplitLayout(
  panels: readonly ClipperSplitPanel[],
  source: FrameEffectSize,
  output: FrameEffectSize,
  faces?: SplitPanelFaces,
  firstShare = 0.5,
): SplitPanelLayout[] {
  return forcedSplitDestinations(output, firstShare).map((destination, index) => {
    const panel = panels[index] ?? panels[0]!;
    const face = faces?.[index];
    if (!face) return { destination, source: splitPanelCrop(panel, destination, source) };
    // Size the crop as usual, then centre it on the tracked face plus the user's nudge.
    const size = splitPanelCrop({ ...panel, x: 0.5, y: 0.5 }, destination, source);
    const centerX = face.x * source.width + (panel.dx ?? 0) * size.sw;
    const centerY = face.y * source.height + (TRACKED_FACE_HEADROOM + (panel.dy ?? 0)) * size.sh;
    return {
      destination,
      source: {
        ...size,
        sx: clamp(centerX - size.sw / 2, 0, source.width - size.sw),
        sy: clamp(centerY - size.sh / 2, 0, source.height - size.sh),
      },
    };
  });
}

/**
 * Default panels: the left and right thirds of the frame, a little above centre. At zoom 1 a
 * half-screen panel from a 16:9 source spans ~2/3 of its width (both people would show in both
 * panels), so start zoomed to about a third of the width: one person per panel.
 */
export function defaultSplitPanels(): ClipperSplitPanel[] {
  return [
    { x: 0.3, y: 0.45, zoom: 2 },
    { x: 0.7, y: 0.45, zoom: 2 },
  ];
}
