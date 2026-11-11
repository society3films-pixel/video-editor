import { drawClipperFrame, resolveClipperFrameGeometry } from "../engine/render/index";
import { beatPulseZoom } from "./beat-sync.util";
import { activeInserts, pauseIdlePreviewInserts, previewInsertFrame } from "./broll.util";
import type { ClipperFrameContext } from "../engine/render/index";
import {
  findGapJumpTarget,
  localTimeToSourceTime,
  sourceTimeToLocalTime,
} from "../engine/segmentation/clip-time.util";
import type { FrameEffectSize } from "../lib/media/video-frame-effect.util";
import { drawClipEditOverlays, punchInRect } from "./clip-edit-draw.util";
import {
  findSegmentAt,
  getOutputDuration,
  sourceToOutputTime,
  type ClipEdit,
} from "./clip-edit.util";
import {
  defaultSplitPanels,
  forcedSplitDestinations,
  splitPanelCrop,
  type ClipperFramingValue,
  type ClipperSplitPanel,
} from "../engine/render/framing-override.util";
import type { ClipEditorSource } from "./clip-editor-source.util";

/** Largest preview canvas height; the final render still uses the full export size. */
const PREVIEW_MAX_HEIGHT = 960;

/**
 * Maps between the `<video>` element's clock and the editor's clip-local clock.
 * Export mode plays the exported file (identical clocks); source mode plays the project's
 * range video, where a clip may be several disjoint windows.
 */
export interface EditorTimeMap {
  toLocal(videoTime: number): number;
  toVideo(localTime: number): number;
  /** Video time to jump to when playback has run into a gap between clip windows. */
  gapJump(videoTime: number): number | null;
  /** True once playback has passed the end of the clip. */
  isPastEnd(videoTime: number): boolean;
}

export function createEditorTimeMap(source: ClipEditorSource | null, duration: number): EditorTimeMap {
  if (!source) {
    return {
      toLocal: (time) => time,
      toVideo: (time) => time,
      gapJump: () => null,
      isPastEnd: (time) => time >= duration - 0.01,
    };
  }
  const segments = source.clip.segments;
  const last = segments[segments.length - 1]!;
  return {
    toLocal: (time) => sourceTimeToLocalTime(segments, time),
    toVideo: (time) => localTimeToSourceTime(segments, time),
    gapJump: (time) => findGapJumpTarget(segments, time),
    isPastEnd: (time) => time >= last.endSec - 0.01 || time < segments[0]!.startSec - 0.5,
  };
}

export function previewCanvasSize(output: FrameEffectSize): FrameEffectSize {
  const scale = Math.min(1, PREVIEW_MAX_HEIGHT / output.height);
  return { width: Math.round(output.width * scale), height: Math.round(output.height * scale) };
}

/** Draws one preview frame: the (re-framed, re-captioned) clip plus the editor overlays. */
export function drawEditorPreviewFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  size: FrameEffectSize,
  edit: ClipEdit,
  localTime: number,
  source: ClipEditorSource | null,
  frameContext: ClipperFrameContext | null,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size.width, size.height);
  const segment = findSegmentAt(edit.segments, localTime);
  // Beats are on the saved video's clock, which starts with the hook (if any).
  const hookLength = edit.hook ? edit.hook.end - edit.hook.start : 0;
  const zoom = (segment?.zoom ?? 1) * beatPulseZoom(edit.beatPulse, sourceToOutputTime(edit.segments, localTime) + hookLength);
  if (zoom > 1) {
    // Same transform the renderer uses, so punch-ins preview exactly.
    const rect = punchInRect(size.width, size.height, zoom, segment?.zoomCenter);
    ctx.setTransform(zoom, 0, 0, zoom, rect.x, rect.y);
  }
  if (video.readyState >= 2 && video.videoWidth > 0) {
    if (source && frameContext) {
      const videoSize = { width: video.videoWidth, height: video.videoHeight };
      drawClipperFrame(source.formatDef, ctx, video, videoSize, size, video.currentTime, frameContext);
    } else {
      ctx.drawImage(video, 0, 0, size.width, size.height);
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!segment) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, size.width, size.height);
  } else {
    const total = getOutputDuration(edit.segments);
    const outputTime = sourceToOutputTime(edit.segments, localTime);
    if (edit.inserts?.length) pauseIdlePreviewInserts(activeInserts(edit.inserts, outputTime));
    drawClipEditOverlays(ctx, edit, outputTime, total, size.width, size.height, {
      coverPreview: true,
      insertFrame: (insert, insertTime) => previewInsertFrame(insert, insertTime, !video.paused, () => {}),
    });
  }
  ctx.restore();
}

/**
 * Where the AI camera is looking at a moment, as a locked-camera framing. Used when switching a
 * part from AI framing to a locked shot so the picture doesn't jump.
 */
export function lockedFramingFromAi(
  source: ClipEditorSource,
  baseFrameContext: ClipperFrameContext,
  videoSize: FrameEffectSize,
  videoTime: number,
  current: ClipperFramingValue,
): ClipperFramingValue {
  const geometry = resolveClipperFrameGeometry(source.formatDef, videoSize, source.outputSize, videoTime, {
    ...baseFrameContext,
    framing: undefined,
  });
  const crop = geometry.panels[0]?.source;
  if (!crop) return { ...current, mode: "fixed", x: 0.5, y: 0.5 };
  return {
    ...current,
    mode: "fixed",
    x: (crop.sx + crop.sw / 2) / videoSize.width,
    y: (crop.sy + crop.sh / 2) / videoSize.height,
    zoom: 1,
  };
}

/** Converts a drag on the preview (in preview pixels) into a framing change. */
export function dragFraming(
  framing: ClipperFramingValue,
  dx: number,
  dy: number,
  preview: FrameEffectSize,
  videoSize: FrameEffectSize,
): ClipperFramingValue {
  const zoom = Math.max(1, framing.zoom);
  if (framing.mode === "auto") {
    return {
      ...framing,
      x: Math.max(-1, Math.min(1, framing.x - dx / (preview.width * zoom))),
      y: Math.max(-1, Math.min(1, framing.y - dy / (preview.height * zoom))),
    };
  }
  const aspect = preview.width / preview.height;
  const naturalW = Math.min(videoSize.width, videoSize.height * aspect);
  const naturalH = naturalW / aspect;
  const cropWFraction = naturalW / zoom / videoSize.width;
  const cropHFraction = naturalH / zoom / videoSize.height;
  return {
    ...framing,
    x: Math.max(0, Math.min(1, framing.x - (dx / preview.width) * cropWFraction)),
    y: Math.max(0, Math.min(1, framing.y - (dy / preview.height) * cropHFraction)),
  };
}

/**
 * Panels to start a forced split screen from: the AI's own split at this moment when it has
 * one, otherwise the left and right thirds of the frame.
 */
export function splitPanelsFromAi(
  source: ClipEditorSource,
  baseFrameContext: ClipperFrameContext,
  videoSize: FrameEffectSize,
  videoTime: number,
): ClipperSplitPanel[] {
  const geometry = resolveClipperFrameGeometry(source.formatDef, videoSize, source.outputSize, videoTime, {
    ...baseFrameContext,
    framing: undefined,
  });
  if (geometry.mode !== "split" || geometry.panels.length < 2) return defaultSplitPanels();
  const destinations = forcedSplitDestinations(source.outputSize);
  return geometry.panels.slice(0, 2).map((panel, index) => {
    const crop = panel.source;
    const natural = splitPanelCrop({ x: 0.5, y: 0.5, zoom: 1 }, destinations[index]!, videoSize);
    return {
      x: (crop.sx + crop.sw / 2) / videoSize.width,
      y: (crop.sy + crop.sh / 2) / videoSize.height,
      zoom: Math.max(1, Math.min(3, natural.sw / Math.max(1, crop.sw))),
    };
  });
}

/**
 * Moves one split-screen panel by a drag of (dx, dy) preview pixels. For an AI-tracked split
 * the drag nudges the panel's framing relative to the tracked face instead.
 */
export function dragSplitPanel(
  panels: readonly ClipperSplitPanel[],
  index: number,
  dx: number,
  dy: number,
  preview: FrameEffectSize,
  videoSize: FrameEffectSize,
  follow = false,
): ClipperSplitPanel[] {
  const destination = forcedSplitDestinations(preview)[index];
  const panel = panels[index];
  if (!destination || !panel) return [...panels];
  if (follow) {
    const nudged = {
      ...panel,
      dx: Math.max(-0.5, Math.min(0.5, (panel.dx ?? 0) - dx / destination.width)),
      dy: Math.max(-0.5, Math.min(0.5, (panel.dy ?? 0) - dy / destination.height)),
    };
    return panels.map((item, i) => (i === index ? nudged : item));
  }
  const crop = splitPanelCrop(panel, destination, videoSize);
  const next = {
    ...panel,
    x: Math.max(0, Math.min(1, panel.x - (dx / destination.width) * (crop.sw / videoSize.width))),
    y: Math.max(0, Math.min(1, panel.y - (dy / destination.height) * (crop.sh / videoSize.height))),
  };
  return panels.map((item, i) => (i === index ? next : item));
}
