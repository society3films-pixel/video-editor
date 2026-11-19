import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { buildClipsFromWordRanges } from "./ai-clip-builder.util";
import { clipPayloadFromWordRanges } from "./clip-word-ranges.util";
import { payloadClipToWordSegments } from "../../hooks/clipper-pipeline/clip-preview.util";
import { selectionWithinTimeRange } from "../../components/clipper-manual-clip-range.util";

// Words 0-9 at 10-14.5 s, then 6 s of silence (music), then words 10-19 at 20.5-25 s.
const words = [
  ...Array.from({ length: 10 }, (_, i) => ({
    text: `a${i}`,
    start: 10 + i * 0.5,
    end: 10 + i * 0.5 + 0.4,
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    text: `b${i}`,
    start: 20.5 + i * 0.5,
    end: 20.5 + i * 0.5 + 0.4,
  })),
];

describe("clips with exact start and end times", () => {
  it("keeps silence after the last word instead of snapping to it", () => {
    const [padded] = buildClipsFromWordRanges(
      words,
      [{ index: 0, segments: [{ wordStartIdx: 0, wordEndIdx: 9 }] }],
      3,
      60,
    );
    expect(padded!.endSec).toBeLessThan(15.5);
    const [exact] = buildClipsFromWordRanges(
      words,
      [
        {
          index: 0,
          segments: [
            {
              wordStartIdx: 0,
              wordEndIdx: 9,
              exactStartSec: 9,
              exactEndSec: 19,
            },
          ],
        },
      ],
      3,
      60,
    );
    expect(exact).toMatchObject({ startSec: 9, endSec: 19 });
    expect(exact!.durationSec).toBeCloseTo(10, 6);
    expect(exact!.words).toHaveLength(10);
  });

  it("survives saving and loading the project", () => {
    const payload = clipPayloadFromWordRanges(
      3,
      [{ wordStartIdx: 0, wordEndIdx: 9, exactStartSec: 9, exactEndSec: 19 }],
      words,
      "Intro",
      60,
    )!;
    expect(payload.segments[0]).toMatchObject({
      startSec: 9,
      endSec: 19,
      exact: true,
    });
    const restored = JSON.parse(JSON.stringify(payload));
    expect(payloadClipToWordSegments(restored)).toEqual([
      { wordStartIdx: 0, wordEndIdx: 9, exactStartSec: 9, exactEndSec: 19 },
    ]);
    // Word-only clips are unchanged (no exact flag, padded on load as before).
    const plain = clipPayloadFromWordRanges(
      4,
      [{ wordStartIdx: 10, wordEndIdx: 19 }],
      words,
      undefined,
      60,
    )!;
    expect(plain.segments[0]!.exact).toBeUndefined();
    expect(payloadClipToWordSegments(plain)).toEqual([
      { wordStartIdx: 10, wordEndIdx: 19 },
    ]);
  });

  it("a time range picks the words inside it, not the nearest ones outside", () => {
    // 15-24 s: from the silence after the first sentence to inside the second.
    expect(selectionWithinTimeRange(words, 15, 24)).toEqual({
      startIdx: 10,
      endIdx: 16,
    });
    expect(selectionWithinTimeRange(words, 9, 19)).toEqual({
      startIdx: 0,
      endIdx: 9,
    });
  });
});
