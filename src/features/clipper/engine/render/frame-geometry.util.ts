import { evenInt } from "../../lib/media/video-draw.util";
import type { FrameEffectSize } from "../../lib/media/video-frame-effect.util";
import type { NormalizedBox } from "../../shared/smart-crop.util";
import type { ClipperFormatDef } from "../../shared/formats.util";
import { cropRectForCentroid } from "../reframe";
import { deriveRegionsFromLayoutTracks, findActiveRegion } from "../reframe/collage";
import type { ClipperCropRect } from "../types/reframe.types";
import {
  isClipperRuntimeSmartCropBlob,
  type ClipperFrameAnalysis,
} from "../../shared/smart-crop.util";
import { resolveAutoFlipCropRender } from "./crop-resolvers.util";
import { resolveFrameLayoutBranch } from "./frame-layout-branch.util";
import { resolveClipperLayoutRender } from "./layout-resolvers.util";
import {
  applyFramingOverride,
  evaluateClipFraming,
  clipShotRangeAt,
  fitWholeFrame,
  forcedSplitLayout,
  isForcedSplit,
  screenFaceLayout,
  slowZoomCrop,
  type ClipFramingRender,
} from "./framing-override.util";
import { sourceTimeToLocalTime } from "../segmentation/clip-time.util";
import type { FaceSampleCache } from "../reframe/cache.util";
import { largestFaceTrackFor, splitFaceTracksFor, trackedPositionAt } from "./split-tracking.util";
import { firstPanelShare, speakerEmphasisAt } from "./speaker-emphasis.util";
import type { ClipperClipSegmentWindow } from "../segmentation/segmentation.types";

export interface ClipperFramePanelGeometry {
  source: ClipperCropRect;
  destination: { x: number; y: number; width: number; height: number };
}

export interface ClipperFrameGeometry {
  mode: "single-crop" | "split" | "contain";
  panels: ClipperFramePanelGeometry[];
  /** Fill behind the panels with a blurred copy of the whole frame. */
  blurBackground?: boolean;
}

// A smart-crop blob is immutable for the lifetime of a render/session.  The
// split-region derivation used to rescan its complete layout track on every
// decoded frame, even though the result cannot change between frames.
const layoutRegionCache = new WeakMap<object, ReturnType<typeof deriveRegionsFromLayoutTracks>>();

function cachedLayoutRegions(
  smartCropAnalysis: ClipperFrameAnalysis | null | undefined,
): ReturnType<typeof deriveRegionsFromLayoutTracks> {
  if (!smartCropAnalysis) return [];
  const cached = layoutRegionCache.get(smartCropAnalysis);
  if (cached) return cached;
  const regions = deriveRegionsFromLayoutTracks(smartCropAnalysis);
  layoutRegionCache.set(smartCropAnalysis, regions);
  return regions;
}

function clampToContent(crop: ClipperCropRect, content: NormalizedBox | undefined, source: FrameEffectSize): ClipperCropRect {
  if (!content || (content.x <= 1e-6 && content.y <= 1e-6 && content.width >= 1 - 1e-6 && content.height >= 1 - 1e-6)) return crop;
  const left = content.x * source.width;
  const top = content.y * source.height;
  const right = (content.x + content.width) * source.width;
  const bottom = (content.y + content.height) * source.height;
  const sx = Math.max(crop.sx, left);
  const sy = Math.max(crop.sy, top);
  const ex = Math.min(crop.sx + crop.sw, right);
  const ey = Math.min(crop.sy + crop.sh, bottom);
  return ex - sx < 2 || ey - sy < 2 ? crop : { sx, sy, sw: ex - sx, sh: ey - sy };
}

function coverCrop(crop: ClipperCropRect, output: FrameEffectSize): ClipperCropRect {
  const targetRatio = output.width / Math.max(1, output.height);
  let { sx, sy, sw, sh } = crop;
  const ratio = sw / Math.max(1, sh);
  if (ratio > targetRatio + 0.001) { const next = sh * targetRatio; sx += (sw - next) / 2; sw = next; }
  else if (ratio < targetRatio - 0.001) { const next = sw / targetRatio; sy += (sh - next) / 2; sh = next; }
  return { sx, sy, sw, sh };
}

function splitDestinations(count: number, output: FrameEffectSize): ClipperFramePanelGeometry["destination"][] {
  if (count === 2) {
    const top = evenInt(output.height / 2);
    return [{ x: 0, y: 0, width: output.width, height: top }, { x: 0, y: top, width: output.width, height: output.height - top }];
  }
  if (output.width / output.height < 1) {
    const primary = evenInt(output.height / 2); const lower = output.height - primary; const left = evenInt(output.width / 2);
    return [{ x: 0, y: 0, width: output.width, height: primary }, { x: 0, y: primary, width: left, height: lower }, { x: left, y: primary, width: output.width - left, height: lower }];
  }
  const primary = evenInt(output.width * 0.6); const secondary = output.width - primary; const upper = evenInt(output.height / 2);
  return [{ x: 0, y: 0, width: primary, height: output.height }, { x: primary, y: 0, width: secondary, height: upper }, { x: primary, y: upper, width: secondary, height: output.height - upper }];
}

/** Exact crop/panel geometry consumed by the canvas renderer, without captions. */
export function resolveClipperFrameGeometry(formatDef: ClipperFormatDef, source: FrameEffectSize, output: FrameEffectSize, t: number, render: { smartCropAnalysis?: ClipperFrameAnalysis | null; disabledCollageRegionIds: string[]; segments?: ClipperClipSegmentWindow[]; framing?: ClipFramingRender; faceCache?: FaceSampleCache | null }): ClipperFrameGeometry {
  const resolved = formatDef.mode === "crop" ? resolveClipperLayoutRender(render.smartCropAnalysis, formatDef.id, source, t) : undefined;
  const regions = formatDef.mode === "crop" ? cachedLayoutRegions(render.smartCropAnalysis) : [];
  const branch = resolveFrameLayoutBranch(resolved, findActiveRegion(regions, t), render.disabledCollageRegionIds);
  const localT = render.segments?.length ? sourceTimeToLocalTime(render.segments, t) : Math.max(0, t);
  const override = render.framing?.track.keyframes.length ? evaluateClipFraming(render.framing, localT) : undefined;
  if (override?.fit === "blur" && !isForcedSplit(override) && formatDef.mode === "crop") {
    return { mode: "contain", panels: [fitWholeFrame(source, output, override.zoom)], blurBackground: true };
  }
  if (isForcedSplit(override) && override!.screen && formatDef.mode === "crop") {
    const face = render.faceCache ? trackedPositionAt(largestFaceTrackFor(render.faceCache), t) : null;
    return {
      mode: "split",
      panels: screenFaceLayout(override!.split!, source, output, face, Boolean(override!.splitSwap)),
      blurBackground: true,
    };
  }
  if (isForcedSplit(override) && formatDef.mode === "crop") {
    let faces: Array<{ x: number; y: number } | null> | undefined;
    if (override!.splitFollow && render.faceCache) {
      const tracks = splitFaceTracksFor(render.faceCache);
      const left = trackedPositionAt(tracks.left, t);
      const right = trackedPositionAt(tracks.right, t);
      faces = override!.splitSwap ? [right, left] : [left, right];
    }
    const share = override!.splitFollow && override!.splitEmphasis
      ? firstPanelShare(speakerEmphasisAt(render.framing!.track.speakers, localT), Boolean(override!.splitSwap))
      : 0.5;
    return { mode: "split", panels: forcedSplitLayout(override!.split!, source, output, faces, share) };
  }
  const plannedLayout = override?.singleShot && branch.plannedLayout?.mode === "split"
    ? { ...branch.plannedLayout, mode: "single-crop" as const, viewports: [branch.plannedLayout.viewports[0]!] }
    : branch.plannedLayout;
  if (plannedLayout?.mode === "split" && plannedLayout.viewports.length >= 2) {
    const viewports = plannedLayout.viewports.slice(0, 3);
    const destinations = splitDestinations(viewports.length, output);
    return { mode: "split", panels: viewports.map((sourceRect, index) => ({ source: sourceRect, destination: destinations[index]! })) };
  }
  const crop = plannedLayout?.viewports[0]
    ?? (!isClipperRuntimeSmartCropBlob(render.smartCropAnalysis)
      ? resolveAutoFlipCropRender(render.smartCropAnalysis, formatDef.id, source, t)?.cropRect
      : undefined)
    ?? cropRectForCentroid(source.width, source.height, 0.5, 0.5, output.width / output.height);
  let finalCrop = coverCrop(clampToContent(crop, render.smartCropAnalysis?.contentRect, source), output);
  if (override) finalCrop = applyFramingOverride(finalCrop, override, source, output);
  if (override?.slowZoom && render.framing) {
    const duration = render.segments?.length
      ? render.segments.reduce((sum, segment) => sum + Math.max(0, segment.endSec - segment.startSec), 0)
      : Number.POSITIVE_INFINITY;
    const shot = clipShotRangeAt(render.framing, localT, duration);
    if (Number.isFinite(shot.end) && shot.end > shot.start) {
      finalCrop = slowZoomCrop(finalCrop, override.slowZoom, (localT - shot.start) / (shot.end - shot.start), source);
    }
  }
  return { mode: plannedLayout?.mode ?? "single-crop", panels: [{ source: finalCrop, destination: { x: 0, y: 0, width: output.width, height: output.height } }] };
}
