import { describe, expect, it, vi } from "vitest";

// Frame geometry pulls in native-job helpers that touch `window` at import time.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});

import {
  applyFramingOverride,
  evaluateFramingTrack,
  forcedSplitDestinations,
  forcedSplitLayout,
  splitPanelIndexAt,
  shotRangeAt,
  type ClipFramingKeyframe,
  type ClipperFramingValue,
} from "./framing-override.util";
import { resolveClipperFrameGeometry } from "./frame-geometry.util";
import { getClipperFormatDef } from "../../shared/formats.util";

const source = { width: 1920, height: 1080 };
const output = { width: 1080, height: 1920 };
const aiCrop = { sx: 656, sy: 0, sw: 607.5, sh: 1080 };

function value(patch: Partial<ClipperFramingValue> = {}): ClipperFramingValue {
  return { mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false, ...patch };
}
function kf(t: number, patch: Partial<ClipperFramingValue> = {}): ClipFramingKeyframe {
  return { id: `k${t}`, t, ...value(patch) };
}

describe("applyFramingOverride", () => {
  it("nudges the AI crop and keeps it inside the frame", () => {
    const right = applyFramingOverride(aiCrop, value({ x: 0.5 }), source, output);
    expect(right.sx).toBeCloseTo(aiCrop.sx + aiCrop.sw * 0.5);
    const farRight = applyFramingOverride(aiCrop, value({ x: 1 }), source, output);
    expect(farRight.sx + farRight.sw).toBeLessThanOrEqual(source.width + 1e-6);
  });

  it("zooms around the AI centre", () => {
    const zoomed = applyFramingOverride(aiCrop, value({ zoom: 2 }), source, output);
    expect(zoomed.sw).toBeCloseTo(aiCrop.sw / 2);
    expect(zoomed.sx + zoomed.sw / 2).toBeCloseTo(aiCrop.sx + aiCrop.sw / 2);
  });

  it("places a manual camera on a fixed point", () => {
    const locked = applyFramingOverride(aiCrop, value({ mode: "fixed", x: 0.1, y: 0.5 }), source, output);
    expect(locked.sx).toBe(0);
    expect(locked.sw / locked.sh).toBeCloseTo(1080 / 1920);
  });
});

describe("evaluateFramingTrack", () => {
  const boundaries = [5]; // shots: [0,5) and [5,10)

  it("leaves shots without keyframes on AI framing", () => {
    const track = { keyframes: [kf(2, { zoom: 2 })], extraShotBoundaries: [] };
    expect(evaluateFramingTrack(track, boundaries, 7)).toBeUndefined();
    expect(evaluateFramingTrack(track, boundaries, 0)?.zoom).toBe(2);
    expect(evaluateFramingTrack(track, boundaries, 4.9)?.zoom).toBe(2);
  });

  it("glides between keyframes in a shot and never across a shot change", () => {
    const track = {
      keyframes: [kf(1, { mode: "fixed", x: 0.2 }), kf(3, { mode: "fixed", x: 0.6 }), kf(8, { mode: "fixed", x: 0.9 })],
      extraShotBoundaries: [],
    };
    expect(evaluateFramingTrack(track, boundaries, 0.5)?.x).toBeCloseTo(0.2);
    expect(evaluateFramingTrack(track, boundaries, 2)?.x).toBeCloseTo(0.4);
    expect(evaluateFramingTrack(track, boundaries, 4.9)?.x).toBeCloseTo(0.6);
    expect(evaluateFramingTrack(track, boundaries, 5.1)?.x).toBeCloseTo(0.9);
  });

  it("steps instead of blending when the mode changes", () => {
    const track = { keyframes: [kf(1), kf(3, { mode: "fixed", x: 0.6 })], extraShotBoundaries: [] };
    expect(evaluateFramingTrack(track, [], 2)?.mode).toBe("auto");
    expect(evaluateFramingTrack(track, [], 3)?.mode).toBe("fixed");
  });

  it("reports the shot range", () => {
    expect(shotRangeAt([5, 8], 6, 10)).toEqual({ index: 1, start: 5, end: 8 });
    expect(shotRangeAt([5, 8], 9, 10)).toEqual({ index: 2, start: 8, end: 10 });
  });
});

describe("frame geometry with framing", () => {
  it("applies keyframes using clip-local time", () => {
    const formatDef = getClipperFormatDef("tiktok")!;
    const base = resolveClipperFrameGeometry(formatDef, source, output, 12, { disabledCollageRegionIds: [] });
    const framed = resolveClipperFrameGeometry(formatDef, source, output, 12, {
      disabledCollageRegionIds: [],
      segments: [{ startSec: 10, endSec: 20 }],
      framing: {
        track: { keyframes: [kf(1, { mode: "fixed", x: 0, y: 0.5 })], extraShotBoundaries: [] },
        aiShotBoundaries: [],
      },
    });
    expect(base.panels[0]!.source.sx).toBeGreaterThan(0);
    expect(framed.panels[0]!.source.sx).toBe(0);
  });
});

describe("forced split screen", () => {
  const split = [
    { x: 0.25, y: 0.5, zoom: 2 },
    { x: 0.75, y: 0.5, zoom: 4 },
  ];

  it("stacks two panels on vertical outputs and puts them side by side on landscape", () => {
    expect(forcedSplitDestinations({ width: 1080, height: 1920 })).toEqual([
      { x: 0, y: 0, width: 1080, height: 960 },
      { x: 0, y: 960, width: 1080, height: 960 },
    ]);
    expect(forcedSplitDestinations({ width: 1920, height: 1080 }).map((d) => d.x)).toEqual([0, 960]);
    expect(splitPanelIndexAt({ width: 1080, height: 1920 }, 500, 1500)).toBe(1);
  });

  it("crops each panel to its own shape around its point", () => {
    const [top, bottom] = forcedSplitLayout(split, source, output);
    expect(top!.source.sw / top!.source.sh).toBeCloseTo(1080 / 960);
    expect(top!.source.sx + top!.source.sw / 2).toBeCloseTo(0.25 * 1920);
    expect(bottom!.source.sw).toBeCloseTo(top!.source.sw / 1.5); // zoom is capped at 3
    // At zoom 1 the panel is too wide to centre on the left third, so it is kept inside the frame.
    const [wide] = forcedSplitLayout([{ x: 0.25, y: 0.5, zoom: 1 }, split[1]!], source, output);
    expect(wide!.source.sx).toBe(0);
  });

  it("overrides the AI layout in frame geometry", () => {
    const formatDef = getClipperFormatDef("tiktok")!;
    const geometry = resolveClipperFrameGeometry(formatDef, source, output, 1, {
      disabledCollageRegionIds: [],
      framing: { track: { keyframes: [{ ...kf(0), split }], extraShotBoundaries: [] }, aiShotBoundaries: [] },
    });
    expect(geometry.mode).toBe("split");
    expect(geometry.panels).toHaveLength(2);
  });

  it("glides split panels between keyframes and steps when the layout changes", () => {
    const moved = [{ x: 0.35, y: 0.5, zoom: 1 }, { x: 0.75, y: 0.5, zoom: 2 }];
    const track = { keyframes: [{ ...kf(0), split }, { ...kf(2), split: moved }, kf(4)], extraShotBoundaries: [] };
    expect(evaluateFramingTrack(track, [], 1)?.split?.[0]?.x).toBeCloseTo(0.3);
    expect(evaluateFramingTrack(track, [], 3)?.split).toBeDefined();
    expect(evaluateFramingTrack(track, [], 4)?.split).toBeUndefined();
  });
});
