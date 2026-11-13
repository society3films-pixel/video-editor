/** Where a punch-in should zoom: the speaker's face as it appears in the framed clip. */
import { resolveClipperFrameGeometry } from "../engine/render/frame-geometry.util";
import { localTimeToSourceTime } from "../engine/segmentation/clip-time.util";
import type { ClipEditorSource } from "./clip-editor-source.util";

/**
 * Face position (0..1 of the output frame) between clip-local `start` and `end`: the biggest face
 * visible in the frame at a few moments, median of them. Null when no face is visible.
 */
export function faceCenterInOutput(source: ClipEditorSource, start: number, end: number): { x: number; y: number } | null {
  const faceCache = source.frameContext.faceCache;
  if (!faceCache) return null;
  const samples = faceCache.sortedSamples();
  const first = samples.find((s) => s.frameW > 0);
  if (!first) return null;
  const videoSize = { width: first.frameW, height: first.frameH };
  const points: Array<{ x: number; y: number }> = [];
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const local = start + ((i + 0.5) / steps) * Math.max(0, end - start);
    const t = localTimeToSourceTime(source.clip.segments, local);
    const sample = samples.reduce<(typeof samples)[number] | null>(
      (best, s) => (Math.abs(s.time - t) < 0.6 && (!best || Math.abs(s.time - t) < Math.abs(best.time - t)) ? s : best),
      null,
    );
    if (!sample?.faces.length) continue;
    const geometry = resolveClipperFrameGeometry(source.formatDef, videoSize, source.outputSize, t, source.frameContext);
    let best: { x: number; y: number; area: number } | null = null;
    for (const panel of geometry.panels) {
      const { source: crop, destination } = panel;
      for (const face of sample.faces) {
        const cx = face.x + face.width / 2;
        const cy = face.y + face.height / 2;
        if (cx < crop.sx || cx > crop.sx + crop.sw || cy < crop.sy || cy > crop.sy + crop.sh) continue;
        const area = face.width * face.height;
        if (best && area <= best.area) continue;
        best = {
          x: (destination.x + ((cx - crop.sx) / crop.sw) * destination.width) / source.outputSize.width,
          y: (destination.y + ((cy - crop.sy) / crop.sh) * destination.height) / source.outputSize.height,
          area,
        };
      }
    }
    if (best) points.push({ x: best.x, y: best.y });
  }
  if (!points.length) return null;
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const clamp = (v: number) => Math.min(0.95, Math.max(0.05, v));
  // A little below the face centre keeps the chin in; the zoom pulls towards it.
  return { x: clamp(median(points.map((p) => p.x))), y: clamp(median(points.map((p) => p.y)) + 0.03) };
}
