import { getFadeFactor, type ClipEdit, type ClipTextOverlay } from "./clip-edit.util";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const POSITION_Y: Record<ClipTextOverlay["position"], number> = {
  top: 0.14,
  middle: 0.5,
  bottom: 0.82,
};

function wrapLines(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawTextOverlay(ctx: Ctx2D, overlay: ClipTextOverlay, width: number, height: number): void {
  const text = overlay.text.trim();
  if (!text) return;
  const fontSize = Math.max(8, Math.round(height * overlay.size));
  const lineHeight = fontSize * 1.2;
  ctx.font = `800 ${fontSize}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = wrapLines(ctx, text, width * 0.86);
  const blockHeight = lines.length * lineHeight;
  const centerY = Math.min(
    height - blockHeight / 2 - fontSize * 0.4,
    Math.max(blockHeight / 2 + fontSize * 0.4, height * POSITION_Y[overlay.position]),
  );
  const firstY = centerY - blockHeight / 2 + lineHeight / 2;

  if (overlay.background) {
    const padX = fontSize * 0.5;
    const padY = fontSize * 0.25;
    const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + padX * 2;
    const boxHeight = blockHeight + padY * 2;
    const x = width / 2 - boxWidth / 2;
    const y = centerY - boxHeight / 2;
    const radius = fontSize * 0.3;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, radius);
    ctx.fill();
  } else {
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, fontSize * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    lines.forEach((line, index) => ctx.strokeText(line, width / 2, firstY + index * lineHeight));
  }

  ctx.fillStyle = overlay.color;
  lines.forEach((line, index) => ctx.fillText(line, width / 2, firstY + index * lineHeight));
}

/**
 * Draws text overlays and the fade-to-black on top of an already drawn frame. Shared by the
 * live preview canvas and the renderer so the preview matches the saved file.
 */
export function drawClipEditOverlays(
  ctx: Ctx2D,
  edit: ClipEdit,
  outputTime: number,
  outputDuration: number,
  width: number,
  height: number,
): void {
  for (const overlay of edit.textOverlays) {
    if (outputTime >= overlay.start && outputTime < overlay.end) {
      drawTextOverlay(ctx, overlay, width, height);
    }
  }
  const fade = getFadeFactor(edit, outputTime, outputDuration);
  if (fade < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
    ctx.fillRect(0, 0, width, height);
  }
}

/** Punch-ins zoom around this point (fraction of the frame), a little above centre where faces are. */
export const PUNCH_IN_CENTER = { x: 0.5, y: 0.42 } as const;

/** Draw rectangle for a frame zoomed by `zoom` around PUNCH_IN_CENTER. */
export function punchInRect(width: number, height: number, zoom: number): { x: number; y: number; width: number; height: number } {
  const z = Math.max(1, zoom);
  return {
    x: PUNCH_IN_CENTER.x * width * (1 - z),
    y: PUNCH_IN_CENTER.y * height * (1 - z),
    width: width * z,
    height: height * z,
  };
}
