import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { findPerformanceMoments } from "./performance-moments.util";

function levels(): Float32Array {
  const out: number[] = [];
  const speech = (sec: number) => {
    for (let i = 0; i < sec * 50; i++) out.push(i % 10 < 6 ? 0.05 : 0.005);
  };
  const music = (sec: number, loud: (s: number) => number) => {
    for (let i = 0; i < sec * 50; i++) out.push(loud(i / 50) * (0.9 + 0.1 * Math.sin(i)));
  };
  speech(20);
  // A 60 s song, loudest from 30-50 s, then applause (steady noise) for 5 s.
  music(60, (s) => (s > 30 && s < 50 ? 0.3 : 0.12));
  speech(20);
  return Float32Array.from(out);
}

const words = Array.from({ length: 30 }, (_, i) => ({ text: i === 29 ? "now." : "w", start: 5 + i * 0.5, end: 5 + i * 0.5 + 0.4 }));

describe("performance moments", () => {
  it("finds the song's strongest stretch and an explain-then-play clip", () => {
    const moments = findPerformanceMoments(levels(), words);
    const highlight = moments.find((m) => m.kind === "highlight")!;
    expect(highlight.end - highlight.start).toBeGreaterThanOrEqual(20);
    expect(highlight.end - highlight.start).toBeLessThanOrEqual(42);
    // Overlaps the loud part of the song (20 s + 30..50 s).
    expect(highlight.start).toBeGreaterThan(40);
    expect(highlight.start).toBeLessThan(55);
    const talk = moments.find((m) => m.kind === "talk-then-play")!;
    expect(talk.start).toBeLessThan(20);
    expect(talk.end).toBeGreaterThan(25);
  });
});
