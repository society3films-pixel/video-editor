import { describe, expect, it, vi } from "vitest";

// Frame geometry pulls in native-job helpers that touch `window` at import time.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { applyFramingOverride, findFramingOverride, type ClipperFramingOverride } from "./framing-override.util";
import { resolveClipperFrameGeometry } from "./frame-geometry.util";
import { getClipperFormatDef } from "../../shared/formats.util";

const source = { width: 1920, height: 1080 };
const output = { width: 1080, height: 1920 };
const aiCrop = { sx: 656, sy: 0, sw: 607.5, sh: 1080 };

function override(patch: Partial<ClipperFramingOverride>): ClipperFramingOverride {
  return { start: 0, end: 10, mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false, ...patch };
}

describe("framing override", () => {
  it("finds the override covering a clip-local time", () => {
    const items = [override({ start: 0, end: 2 }), override({ start: 5, end: 8, zoom: 2 })];
    expect(findFramingOverride(items, 1)?.start).toBe(0);
    expect(findFramingOverride(items, 3)).toBeUndefined();
    expect(findFramingOverride(items, 6)?.zoom).toBe(2);
  });

  it("nudges the AI crop and keeps it inside the frame", () => {
    const right = applyFramingOverride(aiCrop, override({ x: 0.5 }), source, output);
    expect(right.sx).toBeCloseTo(aiCrop.sx + aiCrop.sw * 0.5);
    expect(right.sw).toBeCloseTo(aiCrop.sw);
    const farRight = applyFramingOverride(aiCrop, override({ x: 1 }), source, output);
    expect(farRight.sx + farRight.sw).toBeLessThanOrEqual(source.width + 1e-6);
  });

  it("zooms around the AI centre", () => {
    const zoomed = applyFramingOverride(aiCrop, override({ zoom: 2 }), source, output);
    expect(zoomed.sw).toBeCloseTo(aiCrop.sw / 2);
    expect(zoomed.sx + zoomed.sw / 2).toBeCloseTo(aiCrop.sx + aiCrop.sw / 2);
  });

  it("locks the camera on a fixed point", () => {
    const locked = applyFramingOverride(aiCrop, override({ mode: "fixed", x: 0.1, y: 0.5 }), source, output);
    expect(locked.sx).toBe(0);
    expect(locked.sh).toBeCloseTo(1080);
    expect(locked.sw / locked.sh).toBeCloseTo(1080 / 1920);
  });

  it("applies in frame geometry using clip-local time", () => {
    const formatDef = getClipperFormatDef("tiktok")!;
    const base = resolveClipperFrameGeometry(formatDef, source, output, 12, { disabledCollageRegionIds: [] });
    const withOverride = resolveClipperFrameGeometry(formatDef, source, output, 12, {
      disabledCollageRegionIds: [],
      segments: [{ startSec: 10, endSec: 20 }],
      framingOverrides: [override({ start: 1, end: 3, mode: "fixed", x: 0, y: 0.5 })],
    });
    expect(base.panels[0]!.source.sx).toBeGreaterThan(0);
    expect(withOverride.panels[0]!.source.sx).toBe(0);
  });
});
