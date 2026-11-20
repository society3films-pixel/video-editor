import { describe, expect, it } from "vitest";
import { clipFramingKey, clipShotBoundaries } from "./clip-framing.util";

describe("clip framing helpers", () => {
  it("maps scene cuts into clip-local time and adds window joins", () => {
    const segments = [
      { startSec: 10, endSec: 20 },
      { startSec: 40, endSec: 45 },
    ];
    expect(clipShotBoundaries(segments, [5, 13, 42, 60])).toEqual([3, 10, 12]);
  });

  it("keys framing by the clip's source windows", () => {
    expect(clipFramingKey({ startSec: 1, endSec: 2, segments: [{ startSec: 1, endSec: 2 }] })).toBe("1.00-2.00");
  });
});
