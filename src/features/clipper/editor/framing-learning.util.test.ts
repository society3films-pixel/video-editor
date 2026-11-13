import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window ??= globalThis;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
import { classifyShots, forgetLearnedFraming, learnedLayouts, learnFromFraming, planFramingWithLearning } from "./framing-learning.util";

const group = (t: number) => ({
  time: t,
  frameW: 1920,
  frameH: 1080,
  faces: [
    { x: 200, y: 300, width: 160, height: 160 },
    { x: 880, y: 300, width: 160, height: 160 },
    { x: 1560, y: 300, width: 160, height: 160 },
  ],
});
const samples = Array.from({ length: 20 }, (_, i) => group(i * 0.5));
const inputs = { aiShotBoundaries: [], faceSamples: samples, clipSegments: [{ startSec: 0, endSec: 10 }] as never, outputAspect: 9 / 16 };
const wholeFrame = { keyframes: [{ id: "k", t: 2, mode: "auto" as const, x: 0, y: 0, zoom: 1, singleShot: false, fit: "blur" as const }], extraShotBoundaries: [] };

describe("framing learning", () => {
  beforeEach(() => forgetLearnedFraming());
  it("classifies group shots", () => {
    expect(classifyShots([], samples, inputs.clipSegments, inputs.outputAspect).get(0)).toBe("group");
  });
  it("learns after three matching fixes and applies it", () => {
    learnFromFraming(wholeFrame, inputs);
    learnFromFraming(wholeFrame, inputs);
    expect(learnedLayouts().group).toBeUndefined();
    learnFromFraming(wholeFrame, inputs);
    expect(learnedLayouts().group).toBe("whole_frame");
    const plan = planFramingWithLearning({ keyframes: [], extraShotBoundaries: [] }, { ...inputs, duration: 10 });
    expect(plan.fixedShots).toEqual([0]);
    expect(plan.track.keyframes[0]).toMatchObject({ fit: "blur" });
  });
});
