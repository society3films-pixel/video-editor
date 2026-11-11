import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});

import {
  applyAutoEdit,
  applyPunchIns,
  DEFAULT_AUTO_EDIT_OPTIONS,
  describeAutoEdit,
  isFillerWord,
  levelGainFromBlocks,
  pickHookText,
  planFramingFixes,
  planPauseCuts,
} from "./auto-edit.util";
import { createInitialClipEdit } from "./clip-edit.util";
import type { WordCue } from "../lib/media/transcription-export.util";

function words(spec: Array<[string, number, number]>): WordCue[] {
  return spec.map(([text, start, end]) => ({ text, start, end }));
}

describe("pause and filler cuts", () => {
  const transcript = words([
    ["So", 0.5, 0.7],
    ["here's", 0.75, 1.0],
    ["the", 1.05, 1.2],
    ["thing.", 1.25, 1.6],
    ["Um,", 3.0, 3.3],
    ["it", 4.5, 4.6],
    ["works.", 4.65, 5.0],
  ]);

  it("recognises fillers but not real words", () => {
    expect(isFillerWord("Um,")).toBe(true);
    expect(isFillerWord("uhh")).toBe(true);
    expect(isFillerWord("like")).toBe(false);
  });

  it("keeps speech runs with padding and drops pauses and fillers", () => {
    const plan = planPauseCuts(transcript, 6)!;
    expect(plan.fillerCount).toBe(1);
    expect(plan.segments.map((s) => [s.start, Number(s.end.toFixed(2))])).toEqual([
      [0.4, 1.78],
      [4.4, 5.18],
    ]);
    expect(plan.removedSec).toBeCloseTo(6 - (1.38 + 0.78), 1);
  });

  it("keeps fillers when asked and returns null without speech", () => {
    const plan = planPauseCuts(transcript, 6, { maxPauseSec: 0.45, leadSec: 0.1, tailSec: 0.18, removeFillers: false })!;
    expect(plan.segments).toHaveLength(3);
    expect(planPauseCuts([], 6)).toBeNull();
  });
});

describe("framing fixes", () => {
  const segments = [{ startSec: 10, endSec: 20 }];
  // Two people far apart (don't fit a 9:16 crop) in the first shot; only one person in the second.
  const samples = Array.from({ length: 20 }, (_, i) => ({
    time: 10 + i * 0.5,
    frameW: 1920,
    frameH: 1080,
    faces:
      i < 10
        ? [{ x: 200, y: 300, width: 160, height: 200 }, { x: 1500, y: 300, width: 160, height: 200 }]
        : [{ x: 900, y: 300, width: 160, height: 200 }],
  }));

  it("splits shots where two people don't fit, leaving others and user-framed shots alone", () => {
    const empty = { keyframes: [], extraShotBoundaries: [] };
    const plan = planFramingFixes(empty, [5], samples, segments, 10, 9 / 16);
    expect(plan.fixedShots).toEqual([0]);
    expect(plan.track.keyframes[0]).toMatchObject({ t: 2.5, splitFollow: true });
    const userFramed = { keyframes: [{ id: "u", t: 1, mode: "fixed" as const, x: 0.5, y: 0.5, zoom: 1, singleShot: false }], extraShotBoundaries: [] };
    expect(planFramingFixes(userFramed, [5], samples, segments, 10, 9 / 16).fixedShots).toEqual([]);
  });

  it("doesn't split when both people fit the crop (landscape)", () => {
    const empty = { keyframes: [], extraShotBoundaries: [] };
    expect(planFramingFixes(empty, [5], samples, segments, 10, 16 / 9).fixedShots).toEqual([]);
  });
});

describe("punch-ins, hook and volume", () => {
  it("zooms every other part", () => {
    const segments = [0, 1, 2, 3].map((i) => ({ id: `s${i}`, start: i, end: i + 1 }));
    const { segments: punched, count } = applyPunchIns(segments);
    expect(count).toBe(2);
    expect(punched.map((s) => s.zoom ?? 1)).toEqual([1, 1.15, 1, 1.15]);
  });

  it("prefers the social title, otherwise the first sentence", () => {
    expect(pickHookText([], "My title")).toBe("My title");
    expect(pickHookText(words([["um", 0, 1], ["this", 1, 2], ["changed", 2, 3], ["everything.", 3, 4], ["Next", 4, 5]]))).toBe(
      "This changed everything.",
    );
    expect(pickHookText(words([["hi", 0, 1]]))).toBeNull();
  });

  it("measures speech level and caps the gain", () => {
    const quiet = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1e-4 : 1e-9)); // -40 dBFS speech
    const result = levelGainFromBlocks(quiet)!;
    expect(result.measuredDb).toBeCloseTo(-40, 0);
    expect(result.gain).toBe(2);
    const loud = Array.from({ length: 100 }, () => 0.1); // -10 dBFS
    expect(levelGainFromBlocks(loud)!.gain).toBeCloseTo(10 ** (-8 / 20), 2);
  });

  it("applies everything as ordinary edit state", () => {
    const transcript = words([["Big", 0.2, 0.5], ["news", 0.5, 0.9], ["today.", 0.9, 1.4], ["It's", 3, 3.3], ["here.", 3.3, 3.8]]);
    const base = { ...createInitialClipEdit(5), framing: { keyframes: [], extraShotBoundaries: [] } };
    const { edit, summary } = applyAutoEdit(base, { duration: 5, words: transcript, levelGain: 1.5 }, DEFAULT_AUTO_EDIT_OPTIONS);
    expect(edit.segments).toHaveLength(2);
    expect(edit.segments[1].zoom).toBe(1.15);
    expect(edit.textOverlays[0].text).toBe("Big news today.");
    expect(edit.volume).toBe(1.5);
    expect(describeAutoEdit(summary)).toMatch(/cut .*s of pauses.*1 punch-in.*hook title.*volume \+3\.5 dB/);
  });
});

import { punchInRect } from "./clip-edit-draw.util";
describe("face-aware punch-ins", () => {
  it("zooms towards the given point and records it on the part", () => {
    const rect = punchInRect(1000, 1000, 1.2, { x: 0.8, y: 0.3 });
    // The point stays where it was on screen.
    expect(rect.x + 0.8 * rect.width).toBeCloseTo(800);
    expect(rect.y + 0.3 * rect.height).toBeCloseTo(300);
    const { segments } = applyPunchIns(
      [
        { id: "a", start: 0, end: 2 },
        { id: "b", start: 2, end: 4 },
      ],
      1.15,
      () => ({ x: 0.7, y: 0.4 }),
    );
    expect(segments[1]).toMatchObject({ zoom: 1.15, zoomCenter: { x: 0.7, y: 0.4 } });
    expect(segments[0]!.zoomCenter).toBeUndefined();
  });
});
