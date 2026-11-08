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
}

/** One panel of a forced split screen: a camera centred on `x`/`y` (0..1 of the source). */
export interface ClipperSplitPanel {
  x: number;
  y: number;
  /** 1 = the largest crop of the panel's shape that fits the source. */
  zoom: number;
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
  if (isForcedSplit(keyframe)) value.split = keyframe.split!.map((panel) => ({ ...panel }));
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
  if (!next || next.t - previous.t < 1e-6 || isForcedSplit(next) !== isForcedSplit(previous)) return toValue(previous);
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
export function forcedSplitDestinations(output: FrameEffectSize): SplitPanelLayout["destination"][] {
  if (output.width > output.height) {
    const left = evenFloor(output.width / 2);
    return [
      { x: 0, y: 0, width: left, height: output.height },
      { x: left, y: 0, width: output.width - left, height: output.height },
    ];
  }
  const top = evenFloor(output.height / 2);
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

export function forcedSplitLayout(
  panels: readonly ClipperSplitPanel[],
  source: FrameEffectSize,
  output: FrameEffectSize,
): SplitPanelLayout[] {
  return forcedSplitDestinations(output).map((destination, index) => ({
    destination,
    source: splitPanelCrop(panels[index] ?? panels[0]!, destination, source),
  }));
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
