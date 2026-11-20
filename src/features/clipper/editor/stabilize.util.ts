/**
 * Video stabilisation for the saved edit. A first pass measures how the picture moves between
 * frames (block matching on small greyscale frames); the path is smoothed, and the render shifts
 * each frame by the difference, zoomed in slightly so the edges never show. Slow, intended moves
 * (pans, the AI camera following someone) survive the smoothing; jitter doesn't.
 */
import { VideoSampleSink } from "mediabunny";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";

export interface StabilizeSettings {
  /** 0..1: how much shake to remove (also sets the smoothing window). */
  strength: number;
}

export interface StabilizePath {
  timestamps: Float64Array;
  /** Correction per frame, as fractions of the frame size. */
  dx: Float32Array;
  dy: Float32Array;
  /** Zoom that hides the borders the shifts uncover. */
  zoom: number;
}

const WIDTH = 240;
const SEARCH = 6;

function grey(data: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) out[j] = data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114;
  return out;
}

function sad(a: Float32Array, b: Float32Array, w: number, h: number, dx: number, dy: number, limit: number): number {
  let sum = 0;
  const margin = SEARCH + 2;
  for (let y = margin; y < h - margin; y += 2) {
    const ay = y * w;
    const by = (y + dy) * w;
    for (let x = margin; x < w - margin; x += 2) {
      sum += Math.abs(a[ay + x]! - b[by + x + dx]!);
    }
    if (sum > limit) return sum;
  }
  return sum;
}

/** Shift (in small-frame pixels) that best maps `previous` onto `current`. */
export function estimateShift(previous: Float32Array, current: Float32Array, w: number, h: number): { dx: number; dy: number } {
  let best = { dx: 0, dy: 0, cost: sad(previous, current, w, h, 0, 0, Infinity) };
  const tryShift = (dx: number, dy: number) => {
    const cost = sad(previous, current, w, h, dx, dy, best.cost);
    if (cost < best.cost) best = { dx, dy, cost };
  };
  for (let dy = -SEARCH; dy <= SEARCH; dy += 2) for (let dx = -SEARCH; dx <= SEARCH; dx += 2) tryShift(dx, dy);
  const coarse = { ...best };
  for (let dy = coarse.dy - 1; dy <= coarse.dy + 1; dy++) for (let dx = coarse.dx - 1; dx <= coarse.dx + 1; dx++) {
    if (Math.abs(dx) <= SEARCH && Math.abs(dy) <= SEARCH) tryShift(dx, dy);
  }
  // Sub-pixel: fit a parabola through the costs either side of the best shift on each axis.
  const refine = (minus: number, centre: number, plus: number) => {
    const denominator = minus - 2 * centre + plus;
    return denominator > 1e-6 ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * denominator))) : 0;
  };
  const at = (dx: number, dy: number) =>
    Math.abs(dx) <= SEARCH && Math.abs(dy) <= SEARCH ? sad(previous, current, w, h, dx, dy, Infinity) : best.cost;
  const fx = refine(at(best.dx - 1, best.dy), best.cost, at(best.dx + 1, best.dy));
  const fy = refine(at(best.dx, best.dy - 1), best.cost, at(best.dx, best.dy + 1));
  return { dx: best.dx + fx, dy: best.dy + fy };
}

/** Corrections from cumulative motion: smoothed path minus actual path, capped. */
export function correctionsFromMotion(
  motion: ReadonlyArray<{ dx: number; dy: number; cut: boolean }>,
  fps: number,
  strength: number,
): { dx: Float32Array; dy: Float32Array; maxShift: number } {
  const n = motion.length;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    // A scene cut restarts the path.
    px[i] = motion[i]!.cut ? 0 : px[i - 1]! + motion[i]!.dx;
    py[i] = motion[i]!.cut ? 0 : py[i - 1]! + motion[i]!.dy;
  }
  const radius = Math.max(2, Math.round(fps * (0.3 + strength * 1.2)));
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const cap = 0.06; // never shift more than 6% of the frame
  let maxShift = 0;
  let segmentStart = 0;
  for (let i = 0; i < n; i++) {
    if (motion[i]!.cut) segmentStart = i;
    let segmentEnd = i;
    while (segmentEnd + 1 < n && !motion[segmentEnd + 1]!.cut && segmentEnd - i < radius) segmentEnd++;
    const from = Math.max(segmentStart, i - radius);
    let sx = 0;
    let sy = 0;
    for (let j = from; j <= segmentEnd; j++) {
      sx += px[j]!;
      sy += py[j]!;
    }
    const count = segmentEnd - from + 1;
    dx[i] = Math.max(-cap, Math.min(cap, (sx / count - px[i]!) * strength));
    dy[i] = Math.max(-cap, Math.min(cap, (sy / count - py[i]!) * strength));
    maxShift = Math.max(maxShift, Math.abs(dx[i]!), Math.abs(dy[i]!));
  }
  return { dx, dy, maxShift };
}

/** Measures camera shake across the whole file. */
export async function analyzeStabilization(
  file: File,
  settings: StabilizeSettings,
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void } = {},
): Promise<StabilizePath> {
  const input = await createMediabunnyInput(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error("This video can't be decoded for stabilising.");
    const duration = await input.computeDuration();
    const height = Math.max(16, Math.round((WIDTH * track.displayHeight) / Math.max(1, track.displayWidth)));
    const canvas = new OffscreenCanvas(WIDTH, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const timestamps: number[] = [];
    const motion: Array<{ dx: number; dy: number; cut: boolean }> = [];
    let previous: Float32Array | null = null;
    for await (const sample of new VideoSampleSink(track).samples()) {
      try {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        sample.draw(ctx, 0, 0, WIDTH, height);
        const current = grey(ctx.getImageData(0, 0, WIDTH, height).data);
        let entry = { dx: 0, dy: 0, cut: false };
        if (previous) {
          const shift = estimateShift(previous, current, WIDTH, height);
          // Big average change = a cut, not shake.
          let diff = 0;
          for (let i = 0; i < current.length; i += 7) diff += Math.abs(current[i]! - previous[i]!);
          const cut = diff / (current.length / 7) > 40;
          entry = { dx: cut ? 0 : shift.dx / WIDTH, dy: cut ? 0 : shift.dy / height, cut };
        }
        motion.push(entry);
        timestamps.push(sample.timestamp);
        previous = current;
        options.onProgress?.(Math.min(1, sample.timestamp / Math.max(0.1, duration)));
      } finally {
        sample.close();
      }
    }
    const fps = timestamps.length > 1 ? (timestamps.length - 1) / Math.max(0.1, timestamps[timestamps.length - 1]! - timestamps[0]!) : 30;
    const strength = Math.min(1, Math.max(0, settings.strength));
    const { dx, dy, maxShift } = correctionsFromMotion(motion, fps, strength);
    return { timestamps: Float64Array.from(timestamps), dx, dy, zoom: 1 + Math.min(0.12, maxShift * 2 + 0.01) };
  } finally {
    input.dispose();
  }
}

/** Correction for the frame at `timestamp` (nearest analysed frame). */
export function correctionAt(path: StabilizePath, timestamp: number): { dx: number; dy: number } {
  const t = path.timestamps;
  if (!t.length) return { dx: 0, dy: 0 };
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < timestamp - 1e-4) lo = mid + 1;
    else hi = mid;
  }
  const index = lo > 0 && Math.abs(t[lo - 1]! - timestamp) < Math.abs(t[lo]! - timestamp) ? lo - 1 : lo;
  return { dx: path.dx[index]!, dy: path.dy[index]! };
}
