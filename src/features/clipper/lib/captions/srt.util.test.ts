import { describe, expect, it } from "vitest";
import { captionGroupsToSrt, srtTimestamp } from "./srt.util";

describe("srt", () => {
  it("formats timestamps and skips removed words", () => {
    expect(srtTimestamp(3725.5)).toBe("01:02:05,500");
    const srt = captionGroupsToSrt([
      { words: [{ text: "hello", start: 1, end: 1.4 }, { text: "um", start: 1.4, end: 1.6, deleted: true }, { text: "there", start: 1.6, end: 2 }], start: 1, end: 2 },
      { words: [{ text: "gone", start: 3, end: 3.2, deleted: true }], start: 3, end: 3.2 },
    ]);
    expect(srt).toBe("1\n00:00:01,000 --> 00:00:02,000\nhello there\n");
  });
});
