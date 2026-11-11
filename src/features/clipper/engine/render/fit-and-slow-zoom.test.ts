import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { resolveClipperFrameGeometry } from "./frame-geometry.util";
import { fitWholeFrame, slowZoomCrop } from "./framing-override.util";
import { getClipperFormatDef } from "../../shared/formats.util";

const source = { width: 1920, height: 1080 };
const output = { width: 1080, height: 1920 };
const keyframe = (extra: object) => ({ id: "k", t: 0, mode: "auto" as const, x: 0, y: 0, zoom: 1, singleShot: false, ...extra });
const render = (extra: object) => ({
  disabledCollageRegionIds: [],
  segments: [{ startSec: 0, endSec: 10 }] as never,
  framing: { track: { keyframes: [keyframe(extra)], extraShotBoundaries: [] }, aiShotBoundaries: [] },
});

describe("whole frame with blurred fill", () => {
  it("fits the full frame, centred, over a blurred background", () => {
    const geometry = resolveClipperFrameGeometry(getClipperFormatDef("vertical-short")!, source, output, 2, render({ fit: "blur" }));
    expect(geometry.mode).toBe("contain");
    expect(geometry.blurBackground).toBe(true);
    const panel = geometry.panels[0]!;
    expect(panel.source).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    expect(panel.destination.width).toBe(1080);
    expect(panel.destination.height).toBeCloseTo(607.5);
    expect(panel.destination.y).toBeCloseTo((1920 - 607.5) / 2);
  });
  it("crops the sides as Size grows", () => {
    const big = fitWholeFrame(source, output, 2);
    expect(big.destination.width).toBe(1080);
    expect(big.source.sw).toBeCloseTo(960);
  });
});

describe("slow zoom", () => {
  it("narrows the crop through the shot", () => {
    const crop = { sx: 600, sy: 0, sw: 607.5, sh: 1080 };
    expect(slowZoomCrop(crop, 0.2, 0, source)).toEqual(crop);
    const end = slowZoomCrop(crop, 0.2, 1, source);
    expect(end.sw).toBeCloseTo(607.5 / 1.2);
    expect(end.sh).toBeCloseTo(900);
  });
  it("is applied by the renderer from the shot's progress", () => {
    const format = getClipperFormatDef("vertical-short")!;
    const start = resolveClipperFrameGeometry(format, source, output, 0, render({ slowZoom: 0.2 })).panels[0]!.source;
    const end = resolveClipperFrameGeometry(format, source, output, 9.99, render({ slowZoom: 0.2 })).panels[0]!.source;
    expect(end.sw / start.sw).toBeCloseTo(1 / 1.2, 2);
  });
});
