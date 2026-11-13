import { evenInt } from "../../lib/media/video-draw.util";
import {
  FrameCanvasCache,
  resetContext,
  type FrameEffectSize,
} from "../../lib/media/video-frame-effect.util";
import type { ClipperFormatDef } from "../../shared/formats.util";
import { canonicalFormatDims } from "../../shared/formats.util";
import type { ClipperResolutionCap, ClipperSettings } from "../../settings/settings.util";
import type { ClipperFrameContext } from "../types/render.types";
import { drawClipperBranding } from "./branding-draw.util";
import { drawClipperCaptions } from "./canvas-draw.util";
import { resolveClipperFrameGeometry } from "./frame-geometry.util";
import { isColorGradeActive, withColorGrade } from "./color-grade.util";

function applyResolutionCap(
  dims: FrameEffectSize,
  cap: ClipperResolutionCap,
): FrameEffectSize {
  if (cap === "source") return dims;
  const targetShort = cap === "1080p" ? 1080 : 720;
  const currentShort = Math.min(dims.width, dims.height);
  if (currentShort <= targetShort) return dims;
  const scale = targetShort / currentShort;
  return { width: evenInt(dims.width * scale), height: evenInt(dims.height * scale) };
}

export function resolveClipperOutputSize(
  formatDef: ClipperFormatDef,
  resolutionCap: ClipperResolutionCap,
): FrameEffectSize {
  return applyResolutionCap(canonicalFormatDims(formatDef), resolutionCap);
}

/** True when frames must go through the canvas (captions, branding or a colour grade). */
export function frameNeedsCanvas(render: ClipperFrameContext, hasBranding: boolean): boolean {
  return render.settings.captions.enabled || hasBranding || isColorGradeActive(render.colorGrade);
}

export function formatNeedsFaceTracking(formatDef: ClipperFormatDef, settings: ClipperSettings): boolean {
  void settings;
  return formatDef.mode === "crop";
}

/** The whole frame scaled to cover the output, blurred and darkened: a background for "fit" framing. */
function drawBlurredFill(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  source: FrameEffectSize,
  output: FrameEffectSize,
): void {
  const scale = Math.max(output.width / source.width, output.height / source.height) * 1.08;
  const width = source.width * scale;
  const height = source.height * scale;
  // Keep any colour grade already set on the context.
  const graded = ctx.filter && ctx.filter !== "none" ? `${ctx.filter} ` : "";
  ctx.save();
  ctx.filter = `${graded}blur(${Math.round(Math.max(output.width, output.height) * 0.025)}px) brightness(0.6)`;
  ctx.drawImage(frame, 0, 0, source.width, source.height, (output.width - width) / 2, (output.height - height) / 2, width, height);
  ctx.restore();
}

/** Full per-frame draw: crop/collage framing + captions + branding. Shared by the live preview and the final render. */
export function drawClipperFrame(
  formatDef: ClipperFormatDef,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  source: FrameEffectSize,
  output: FrameEffectSize,
  t: number,
  render: ClipperFrameContext,
): void {
  const geometry = resolveClipperFrameGeometry(formatDef, source, output, t, render);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, output.width, output.height);
  withColorGrade(ctx, render.colorGrade, { x: 0, y: 0, width: output.width, height: output.height }, () => {
    if (geometry.blurBackground) drawBlurredFill(ctx, frame, source, output);
    for (const panel of geometry.panels) {
      const { source: crop, destination } = panel;
      ctx.drawImage(frame, crop.sx, crop.sy, crop.sw, crop.sh, destination.x, destination.y, destination.width, destination.height);
    }
  });

  drawClipperCaptions(ctx, output, t, render);
  drawClipperBranding(ctx, output, render.settings.branding);
}

/** Draws one preview frame onto a display canvas at a fixed height. */
export function drawClipperPreviewFrame(
  canvas: HTMLCanvasElement,
  frame: CanvasImageSource,
  source: FrameEffectSize,
  formatDef: ClipperFormatDef,
  render: ClipperFrameContext,
  timestampSec: number,
  displayHeight: number,
  cache: FrameCanvasCache,
): void {
  const canonicalOutput = resolveClipperOutputSize(formatDef, render.settings.formats.resolutionCap);
  const scale = displayHeight / canonicalOutput.height;
  const displayW = Math.round(canonicalOutput.width * scale);
  const displayH = displayHeight;
  const output = { width: displayW, height: displayH };

  if (canvas.width !== displayW) canvas.width = displayW;
  if (canvas.height !== displayH) canvas.height = displayH;

  const ctx = cache.get(displayW, displayH);
  ctx.save();
  resetContext(ctx, displayW, displayH);
  try {
    drawClipperFrame(formatDef, ctx, frame, source, output, timestampSec, render);
  } finally {
    ctx.restore();
  }

  const displayCtx = canvas.getContext("2d", { desynchronized: true });
  if (!displayCtx) return;
  displayCtx.drawImage(ctx.canvas, 0, 0, displayW, displayH);
}
