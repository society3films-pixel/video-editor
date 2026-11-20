import { describe, expect, it } from "vitest";
import { firstPanelShare, speakerEmphasisAt, speakerSpansFromActivity, type MouthActivitySample } from "./speaker-emphasis.util";
import { forcedSplitDestinations } from "./framing-override.util";

const words = Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));

function activity(speakerAt: (t: number) => 0 | 1): MouthActivitySample[] {
  const samples: MouthActivitySample[] = [];
  for (let t = 0; t < 10; t += 0.1) {
    const who = speakerAt(t);
    samples.push({ t, left: who === 0 ? 8 : 2, right: who === 1 ? 6 : 1.5 });
  }
  return samples;
}

describe("speakerSpansFromActivity", () => {
  it("finds two turns and fills the gaps", () => {
    const spans = speakerSpansFromActivity(activity((t) => (t < 5 ? 0 : 1)), words, 10);
    expect(spans.map((s) => s.person)).toEqual([0, 1]);
    expect(spans[0]!.start).toBe(0);
    expect(spans[1]!.end).toBe(10);
    expect(spans[0]!.end).toBeCloseTo(spans[1]!.start);
    expect(spans[0]!.end).toBeGreaterThan(4.4);
    expect(spans[0]!.end).toBeLessThan(5.1);
  });

  it("merges a short interjection into the surrounding turn", () => {
    const spans = speakerSpansFromActivity(activity((t) => (t >= 4.9 && t < 5.5 ? 1 : 0)), words, 10);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.person).toBe(0);
  });

  it("returns nothing without activity", () => {
    expect(speakerSpansFromActivity([], words, 10)).toEqual([]);
  });
});

describe("speakerEmphasisAt", () => {
  const spans = [
    { start: 0, end: 5, person: 0 as const },
    { start: 5, end: 10, person: 1 as const },
  ];
  it("is full emphasis away from a change and ramps across it", () => {
    expect(speakerEmphasisAt(spans, 2)).toBeCloseTo(1);
    expect(speakerEmphasisAt(spans, 8)).toBeCloseTo(-1);
    expect(Math.abs(speakerEmphasisAt(spans, 5))).toBeLessThan(0.3);
    expect(speakerEmphasisAt(undefined, 2)).toBe(0);
  });
  it("grows the first panel for its person, respecting swap", () => {
    expect(firstPanelShare(1, false)).toBeCloseTo(0.62);
    expect(firstPanelShare(1, true)).toBeCloseTo(0.38);
    const [top, bottom] = forcedSplitDestinations({ width: 1080, height: 1920 }, 0.62);
    expect(top!.height).toBeGreaterThan(bottom!.height);
    expect(top!.height + bottom!.height).toBe(1920);
  });
});
