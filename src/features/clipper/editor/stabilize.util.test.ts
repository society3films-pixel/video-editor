import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { correctionsFromMotion, estimateShift } from "./stabilize.util";

describe("stabilize", () => {
  it("finds a frame shift with sub-pixel precision", () => {
    const w = 64;
    const h = 40;
    const make = (offset: number) => {
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = 128 + 100 * Math.sin((x - offset) * 0.4) * Math.cos(y * 0.3);
      return out;
    };
    const shift = estimateShift(make(0), make(2.5), w, h);
    expect(shift.dx).toBeGreaterThan(2);
    expect(shift.dx).toBeLessThan(3);
    expect(Math.abs(shift.dy)).toBeLessThan(0.5);
  });
  it("cancels jitter but keeps a steady pan", () => {
    const jitter = Array.from({ length: 90 }, (_, i) => ({ dx: i % 2 ? 0.01 : -0.01, dy: 0, cut: false }));
    const pan = Array.from({ length: 90 }, () => ({ dx: 0.002, dy: 0, cut: false }));
    const j = correctionsFromMotion(jitter, 30, 1);
    expect(Math.abs(j.dx[45]!)).toBeGreaterThan(0.004);
    const p = correctionsFromMotion(pan, 30, 1);
    expect(Math.abs(p.dx[45]!)).toBeLessThan(0.001);
  });
});
