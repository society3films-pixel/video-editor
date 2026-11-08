import type { FrameEffectSize } from "../../lib/media/video-frame-effect.util";
import { cropRectForCentroid } from "../reframe";
import type { ClipperCropRect } from "../types/reframe.types";

/**
 * Manual framing set in the clip editor for one stretch of a clip. Times are clip-local
 * (the same timeline captions use), so they line up with the exported video.
 */
export interface ClipperFramingOverride {
  start: number;
  end: number;
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
}

export const DEFAULT_FRAMING_ZOOM_RANGE = { min: 1, max: 3 } as const;

export function findFramingOverride(
  overrides: readonly ClipperFramingOverride[] | undefined,
  localTime: number,
): ClipperFramingOverride | undefined {
  if (!overrides?.length) return undefined;
  return overrides.find((item) => localTime >= item.start && localTime < item.end);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Applies a manual framing override to an AI crop, keeping the output aspect and source bounds. */
export function applyFramingOverride(
  crop: ClipperCropRect,
  override: ClipperFramingOverride,
  source: FrameEffectSize,
  output: FrameEffectSize,
): ClipperCropRect {
  const aspect = output.width / Math.max(1, output.height);
  const zoom = clamp(override.zoom || 1, DEFAULT_FRAMING_ZOOM_RANGE.min, DEFAULT_FRAMING_ZOOM_RANGE.max);

  let width: number;
  let height: number;
  let centerX: number;
  let centerY: number;
  if (override.mode === "fixed") {
    const natural = cropRectForCentroid(source.width, source.height, 0.5, 0.5, aspect);
    width = natural.sw / zoom;
    height = natural.sh / zoom;
    centerX = clamp(override.x, 0, 1) * source.width;
    centerY = clamp(override.y, 0, 1) * source.height;
  } else {
    width = crop.sw / zoom;
    height = crop.sh / zoom;
    centerX = crop.sx + crop.sw / 2 + clamp(override.x, -1, 1) * crop.sw;
    centerY = crop.sy + crop.sh / 2 + clamp(override.y, -1, 1) * crop.sh;
  }

  width = Math.min(width, source.width);
  height = Math.min(height, source.height);
  const sx = clamp(centerX - width / 2, 0, source.width - width);
  const sy = clamp(centerY - height / 2, 0, source.height - height);
  return { sx, sy, sw: width, sh: height };
}
