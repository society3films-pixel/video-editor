import { getFadeFactor, type ClipEdit, type ClipProgressBar, type ClipTextOverlay } from "./clip-edit.util";
import { activeInserts, drawInsert, type ClipInsert } from "./broll.util";

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

/** Slide/fade in over 0.35 s and out over 0.3 s. */
function entrance(overlay: ClipTextOverlay, t: number): number {
  const into = (t - overlay.start) / 0.35;
  const out = (overlay.end - t) / 0.3;
  const u = Math.max(0, Math.min(1, into, out));
  return u * u * (3 - 2 * u);
}

/** Name (and role) bar at the lower left, above where captions usually sit. */
function drawLowerThird(ctx: Ctx2D, overlay: ClipTextOverlay, width: number, height: number, t: number): void {
  const k = entrance(overlay, t);
  if (k <= 0) return;
  const portrait = height > width;
  const nameSize = Math.round(height * (portrait ? 0.036 : 0.05));
  const roleSize = Math.round(nameSize * 0.62);
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 ${nameSize}px Inter, "Segoe UI", Arial, sans-serif`;
  const nameWidth = ctx.measureText(overlay.text.trim()).width;
  ctx.font = `600 ${roleSize}px Inter, "Segoe UI", Arial, sans-serif`;
  const role = overlay.subtitle?.trim() ?? "";
  const roleWidth = role ? ctx.measureText(role).width : 0;
  const padX = nameSize * 0.6;
  const boxWidth = Math.max(nameWidth, roleWidth) + padX * 2;
  const boxHeight = nameSize * 1.35 + (role ? roleSize * 1.4 : 0) + nameSize * 0.3;
  const x0 = width * 0.05;
  const y0 = height * (portrait ? 0.6 : 0.72);
  const x = x0 - (1 - k) * (boxWidth + x0);
  ctx.globalAlpha *= k;
  ctx.fillStyle = "rgba(10,10,12,0.78)";
  ctx.fillRect(x, y0, boxWidth, boxHeight);
  ctx.fillStyle = overlay.accent || "#ffd400";
  ctx.fillRect(x, y0, Math.max(4, nameSize * 0.16), boxHeight);
  ctx.fillStyle = overlay.color || "#ffffff";
  ctx.font = `800 ${nameSize}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.fillText(overlay.text.trim(), x + padX, y0 + nameSize * 1.25);
  if (role) {
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = `600 ${roleSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillText(role, x + padX, y0 + nameSize * 1.25 + roleSize * 1.4);
  }
  ctx.restore();
}

/** Song title band across the frame: title, then the artist in small capitals. */
function drawTitleCard(ctx: Ctx2D, overlay: ClipTextOverlay, width: number, height: number, t: number): void {
  const k = entrance(overlay, t);
  if (k <= 0) return;
  const titleSize = Math.round(Math.min(width, height) * 0.075);
  const artistSize = Math.round(titleSize * 0.45);
  const centerY = height * POSITION_Y[overlay.position];
  ctx.save();
  ctx.globalAlpha *= k;
  const band = titleSize * 2.6;
  const gradient = ctx.createLinearGradient(0, centerY - band, 0, centerY + band);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0.6)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, centerY - band, width, band * 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${titleSize}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = overlay.color || "#ffffff";
  const lines = wrapLines(ctx, `“${overlay.text.trim()}”`, width * 0.84).slice(0, 2);
  const lift = (1 - k) * titleSize * 0.4;
  lines.forEach((line, index) => ctx.fillText(line, width / 2, centerY - (lines.length - 1) * titleSize * 0.55 + index * titleSize * 1.1 + lift));
  if (overlay.subtitle?.trim()) {
    ctx.font = `700 ${artistSize}px Inter, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = overlay.accent || "#ffd400";
    ctx.fillText(overlay.subtitle.trim().toUpperCase(), width / 2, centerY + lines.length * titleSize * 0.55 + artistSize + lift);
  }
  ctx.restore();
}

function drawTextOverlay(ctx: Ctx2D, overlay: ClipTextOverlay, width: number, height: number, t = overlay.start + 1): void {
  if (overlay.style === "lower-third") return drawLowerThird(ctx, overlay, width, height, t);
  if (overlay.style === "title-card") return drawTitleCard(ctx, overlay, width, height, t);
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
export function drawProgressBar(ctx: Ctx2D, bar: ClipProgressBar, progress: number, width: number, height: number): void {
  const thickness = Math.max(2, Math.round(height * bar.thickness));
  const y = bar.position === "top" ? 0 : height - thickness;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, y, width, thickness);
  ctx.fillStyle = bar.color;
  ctx.fillRect(0, y, width * Math.min(1, Math.max(0, progress)), thickness);
}

/** The cover's title: big, bold, wrapped, centred in the upper part of the frame on a dark band. */
export function drawCoverTitle(ctx: Ctx2D, title: string, width: number, height: number): void {
  const text = title.trim();
  if (!text) return;
  const fontSize = Math.round(Math.min(width, height) * (width < height ? 0.095 : 0.075));
  ctx.save();
  ctx.font = `900 ${fontSize}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrapLines(ctx, text.toUpperCase(), width * 0.86).slice(0, 4);
  const lineHeight = fontSize * 1.12;
  const blockHeight = lines.length * lineHeight;
  const centerY = height * 0.3;
  const gradient = ctx.createLinearGradient(0, centerY - blockHeight, 0, centerY + blockHeight);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0.55)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, centerY - blockHeight, width, blockHeight * 2);
  lines.forEach((line, index) => {
    const y = centerY - blockHeight / 2 + lineHeight * (index + 0.5);
    ctx.lineJoin = "round";
    ctx.lineWidth = fontSize * 0.16;
    ctx.strokeStyle = "#000";
    ctx.strokeText(line, width / 2, y);
    ctx.fillStyle = index % 2 === 0 ? "#ffffff" : "#ffd400";
    ctx.fillText(line, width / 2, y);
  });
  ctx.restore();
}

export function drawClipEditOverlays(
  ctx: Ctx2D,
  edit: ClipEdit,
  outputTime: number,
  outputDuration: number,
  width: number,
  height: number,
  options: {
    coverPreview?: boolean;
    textTime?: number;
    /** Media for a B-roll insert at its own time (null = not ready: skipped). */
    insertFrame?: (insert: ClipInsert, insertTime: number) => { media: CanvasImageSource; width: number; height: number } | null;
  } = {},
): void {
  if (options.coverPreview && edit.cover && Math.abs(outputTime - edit.cover.time) < 0.05) {
    drawCoverTitle(ctx, edit.cover.title, width, height);
    return;
  }
  // Text overlays are timed on the main edit; a hook played first shifts them (textTime).
  const textTime = options.textTime ?? outputTime;
  if (options.insertFrame) {
    for (const insert of activeInserts(edit.inserts, textTime)) {
      const frame = options.insertFrame(insert, textTime - insert.start);
      if (frame) drawInsert(ctx, frame.media, frame.width, frame.height, insert, textTime - insert.start, width, height);
    }
  }
  for (const overlay of edit.textOverlays) {
    if (textTime >= overlay.start && textTime < overlay.end) {
      drawTextOverlay(ctx, overlay, width, height, textTime);
    }
  }
  if (edit.progressBar) drawProgressBar(ctx, edit.progressBar, outputTime / Math.max(1e-6, outputDuration), width, height);
  const fade = getFadeFactor(edit, outputTime, outputDuration);
  if (fade < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
    ctx.fillRect(0, 0, width, height);
  }
}

/** Punch-ins zoom around this point (fraction of the frame), a little above centre where faces are. */
export const PUNCH_IN_CENTER = { x: 0.5, y: 0.42 } as const;

/** Draw rectangle for a frame zoomed by `zoom` around PUNCH_IN_CENTER. */
export function punchInRect(
  width: number,
  height: number,
  zoom: number,
  center: { x: number; y: number } = PUNCH_IN_CENTER,
): { x: number; y: number; width: number; height: number } {
  const z = Math.max(1, zoom);
  const cx = Math.min(1, Math.max(0, center.x));
  const cy = Math.min(1, Math.max(0, center.y));
  return {
    x: cx * width * (1 - z),
    y: cy * height * (1 - z),
    width: width * z,
    height: height * z,
  };
}
