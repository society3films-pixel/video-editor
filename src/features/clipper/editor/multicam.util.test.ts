import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("../../../shared/persistence/local-database.util", () => ({ localRecordGet: vi.fn(), localRecordPut: vi.fn() }));
import { angleAt, angleCrop, bestLag } from "./multicam.util";

describe("multicam", () => {
  it("finds the lag of a sound pattern", () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const target = Float32Array.from({ length: 1200 }, rand);
    const reference = target.slice(300, 700);
    expect(bestLag(reference, target).lag).toBe(300);
  });
  it("picks the angle per part or during songs, and crops it to the output", () => {
    const angles = [{ id: "a", assetId: "x", name: "a", offsetSec: 0, confidence: 1, x: 0.5, y: 0.5, zoom: 1 }];
    const edit = { angles, angleForSongs: "a", musicSections: [{ start: 10, end: 20, gain: 1 }] };
    expect(angleAt(edit, { id: "s", start: 0, end: 30 }, 5)).toBeNull();
    expect(angleAt(edit, { id: "s", start: 0, end: 30 }, 15)?.id).toBe("a");
    expect(angleAt({ ...edit, angleForSongs: null }, { id: "s", start: 0, end: 30, angle: "a" }, 5)?.id).toBe("a");
    const crop = angleCrop({ x: 0.5, y: 0.5, zoom: 1 }, 1920, 1080, 1080, 1920);
    expect(crop.sh).toBe(1080);
    expect(crop.sw).toBeCloseTo(607.5);
  });
});
