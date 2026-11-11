import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { faceCoverage, framingIssuesFromObservations, shakeAmount, type FrameObservation } from "./framing-check.util";

const crop = { sx: 600, sy: 0, sw: 600, sh: 1080 };
const face = (x: number) => ({ x, y: 300, width: 200, height: 200 });

function observations(make: (t: number) => Partial<FrameObservation>, duration = 4): FrameObservation[] {
  const list: FrameObservation[] = [];
  for (let t = 0; t < duration; t += 0.25) list.push({ t, faces: [], crops: [crop], frameW: 1920, mode: "single-crop", ...make(t) });
  return list;
}

describe("framing check", () => {
  it("measures face coverage", () => {
    expect(faceCoverage(face(700), [crop])).toBe(1);
    expect(faceCoverage(face(1100), [crop])).toBeCloseTo(0.5);
    expect(faceCoverage(face(100), [crop])).toBe(0);
  });
  it("flags a cut-off face, a missing person and an empty frame per shot", () => {
    const issues = framingIssuesFromObservations(
      observations((t) => ({ faces: t < 2 ? [face(1100)] : [face(700), face(100)] })),
      [2],
      4,
    );
    expect(issues.map((i) => [i.kind, i.shotIndex])).toEqual([
      ["face-cut", 0],
      ["person-missing", 1],
    ]);
    const empty = framingIssuesFromObservations(observations(() => ({ faces: [face(100)] })), [], 4);
    expect(empty.map((i) => i.kind)).toEqual(["nobody-in-frame"]);
  });
  it("is quiet for good framing and split screens", () => {
    expect(framingIssuesFromObservations(observations(() => ({ faces: [face(700)] })), [], 4)).toEqual([]);
    const split = observations(() => ({ faces: [face(700), face(100)], mode: "split", crops: [crop, { sx: 0, sy: 0, sw: 600, sh: 1080 }] }));
    expect(framingIssuesFromObservations(split, [], 4)).toEqual([]);
  });
  it("detects back-and-forth camera movement but not a smooth pan", () => {
    const shaky = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, x: 900 + (i % 2 ? 40 : -40), width: 600 }));
    const pan = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, x: 600 + i * 30, width: 600 }));
    expect(shakeAmount(shaky)).toBeGreaterThan(1);
    expect(shakeAmount(pan)).toBe(0);
  });
});
