import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { musicAmount, musicSectionsFromLevels } from "./music-detect.util";
import { planPauseCuts } from "./auto-edit.util";

/** 20 ms frames: speech bursts (syllables with dips), then steady music, then speech again. */
function levels(): Float32Array {
  const out: number[] = [];
  const speech = (sec: number, level: number) => {
    for (let i = 0; i < sec * 50; i++) out.push(i % 10 < 6 ? level * (0.8 + 0.4 * Math.sin(i)) : level * 0.1);
  };
  const music = (sec: number, level: number) => {
    for (let i = 0; i < sec * 50; i++) out.push(level * (0.85 + 0.15 * Math.sin(i * 0.7)));
  };
  speech(10, 0.05);
  music(12, 0.2);
  speech(8, 0.05);
  return Float32Array.from(out);
}

describe("music detection", () => {
  it("finds the song between talking, and a gain to match the talking", () => {
    const sections = musicSectionsFromLevels(levels(), []);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.start).toBeGreaterThanOrEqual(9);
    expect(sections[0]!.start).toBeLessThanOrEqual(11);
    expect(sections[0]!.end).toBeGreaterThanOrEqual(21);
    expect(sections[0]!.end).toBeLessThanOrEqual(23);
    expect(sections[0]!.gain).toBeLessThan(0.6);
    expect(musicAmount(sections, 15).amount).toBe(1);
    expect(musicAmount(sections, 5).amount).toBe(0);
  });
  it("never cuts inside a protected song, and keeps its fillers", () => {
    const words = [
      { text: "so", start: 0, end: 0.3 },
      { text: "um", start: 3, end: 3.2 },
      { text: "la", start: 6, end: 6.3 },
      { text: "back", start: 12, end: 12.3 },
    ];
    const plan = planPauseCuts(words, 13, { maxPauseSec: 0.45, leadSec: 0.1, tailSec: 0.18, removeFillers: true, protectRanges: [{ start: 2, end: 10 }] })!;
    const covers = (t: number) => plan.segments.some((s) => t >= s.start && t < s.end);
    for (const t of [2.5, 3.1, 5, 8, 9.5]) expect(covers(t)).toBe(true);
    expect(plan.fillerCount).toBe(0);
  });
});
