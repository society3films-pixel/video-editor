import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});

import { buildSplitFaceTracks, trackedPositionAt } from "./split-tracking.util";
import { forcedSplitLayout } from "./framing-override.util";
import { resolveClipperFrameGeometry } from "./frame-geometry.util";
import { getClipperFormatDef } from "../../shared/formats.util";
import type { FaceBoxSample } from "../../shared/face-samples.util";

const W = 1920;
const H = 1080;

/** Two people: one drifting right on the left side, one fixed on the right side. */
function samples(): FaceBoxSample[] {
  return Array.from({ length: 21 }, (_, i) => ({
    time: i * 0.5,
    frameW: W,
    frameH: H,
    faces: [
      { x: 300 + i * 10, y: 300, width: 160, height: 200 },
      { x: 1400, y: 320, width: 160, height: 200 },
    ],
    sceneCut: i === 12,
  }));
}

describe("AI-tracked split screen", () => {
  it("tracks the left and right person separately", () => {
    const tracks = buildSplitFaceTracks(samples());
    expect(tracks.left).toHaveLength(21);
    const left = trackedPositionAt(tracks.left, 3)!;
    const right = trackedPositionAt(tracks.right, 3)!;
    expect(left.x).toBeLessThan(0.3);
    expect(right.x).toBeGreaterThan(0.7);
  });

  it("follows a person who drifts", () => {
    const tracks = buildSplitFaceTracks(samples());
    // The left face centre moves from 380px (t=0) to 480px (t=5): ~5% of the frame width.
    const start = trackedPositionAt(tracks.left, 0)!.x;
    const later = trackedPositionAt(tracks.left, 5.5)!.x;
    expect(later - start).toBeGreaterThan(0.04);
  });

  it("doesn't blend across a scene cut and gives up after long gaps", () => {
    const tracks = buildSplitFaceTracks(samples());
    const beforeCut = trackedPositionAt(tracks.left, 5.9)!;
    const atCutSample = tracks.left.find((s) => s.t === 5.5)!;
    expect(beforeCut.x).toBeCloseTo(atCutSample.x);
    expect(trackedPositionAt(tracks.left, 20)).toBeNull();
  });

  it("centres each panel on its tracked face with headroom and nudges", () => {
    const panels = [{ x: 0.5, y: 0.5, zoom: 2 }, { x: 0.5, y: 0.5, zoom: 2, dx: 0.1 }];
    const [top, bottom] = forcedSplitLayout(panels, { width: W, height: H }, { width: 1080, height: 1920 }, [
      { x: 0.2, y: 0.3 },
      { x: 0.75, y: 0.3 },
    ]);
    expect(top!.source.sx + top!.source.sw / 2).toBeCloseTo(0.2 * W);
    expect(top!.source.sy + top!.source.sh / 2).toBeGreaterThan(0.3 * H);
    expect(bottom!.source.sx + bottom!.source.sw / 2).toBeCloseTo(0.75 * W + 0.1 * bottom!.source.sw);
  });

  it("follows faces in frame geometry, swapping people on request", () => {
    const faceCache = { sampleRevision: 1, sortedSamples: () => samples() } as never;
    const split = [{ x: 0.5, y: 0.5, zoom: 2 }, { x: 0.5, y: 0.5, zoom: 2 }];
    const formatDef = getClipperFormatDef("tiktok")!;
    const geometry = (splitSwap: boolean) =>
      resolveClipperFrameGeometry(formatDef, { width: W, height: H }, { width: 1080, height: 1920 }, 2, {
        disabledCollageRegionIds: [],
        faceCache,
        framing: {
          track: {
            keyframes: [{ id: "k", t: 0, mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false, split, splitFollow: true, splitSwap }],
            extraShotBoundaries: [],
          },
          aiShotBoundaries: [],
        },
      });
    const normal = geometry(false);
    expect(normal.panels[0]!.source.sx).toBeLessThan(normal.panels[1]!.source.sx);
    const swapped = geometry(true);
    expect(swapped.panels[0]!.source.sx).toBeGreaterThan(swapped.panels[1]!.source.sx);
  });
});
