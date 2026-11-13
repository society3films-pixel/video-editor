import { describe, expect, it } from "vitest";
import { colorGradeFilter, colorGradeLayers, isColorGradeActive, measureColorCorrection } from "./color-grade.util";

function frame(r: number, g: number, b: number, n = 400) {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) data.set([r, g, b, 255], i * 4);
  return data;
}

describe("colour grade", () => {
  it("brightens dark, warm-cast footage and cools the cast", () => {
    const c = measureColorCorrection([frame(90, 60, 40)])!;
    expect(c.brightness).toBeGreaterThan(1.2);
    expect(c.warmth).toBeLessThan(0);
  });
  it("leaves well-exposed neutral footage nearly alone", () => {
    const pixels = new Uint8ClampedArray(800 * 4);
    for (let i = 0; i < 800; i++) {
      const v = i % 2 ? 60 : 190;
      pixels.set([v, v + 10, v - 5, 255], i * 4);
    }
    const c = measureColorCorrection([pixels])!;
    expect(Math.abs(c.brightness - 1)).toBeLessThan(0.1);
    expect(Math.abs(c.warmth)).toBeLessThan(0.1);
  });
  it("scales the look with strength", () => {
    expect(colorGradeFilter({ style: "bw", intensity: 1, auto: null })).toContain("grayscale(1.000)");
    expect(colorGradeFilter({ style: "bw", intensity: 0.5, auto: null })).toContain("grayscale(0.500)");
    expect(colorGradeLayers({ style: "warm", intensity: 0.5, auto: null })[0]!.alpha).toBeCloseTo(0.14);
    expect(isColorGradeActive({ style: "none", intensity: 1, auto: null })).toBe(false);
  });
});
