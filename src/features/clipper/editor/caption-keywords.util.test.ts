import { describe, expect, it } from "vitest";
import { clearKeywords, countKeywords, highlightKeywords, keywordScore, toggleWordEmphasis } from "./caption-keywords.util";

const group = (text: string, start: number) => {
  const words = text.split(" ").map((w, i) => ({ text: w, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
  return { words, start, end: start + words.length * 0.3 };
};

describe("caption keywords", () => {
  it("prefers numbers and strong words over filler", () => {
    expect(keywordScore("really", false)).toBe(0);
    expect(keywordScore("$5,000", false)).toBe(10);
    expect(keywordScore("revenue", false)).toBeGreaterThan(0);
    expect(keywordScore("Tokyo", false)).toBeGreaterThan(keywordScore("tokyo", false));
  });
  it("marks at most one per line and not on back-to-back lines unless strong", () => {
    const groups = [group("we doubled our revenue", 0), group("in just three months", 2), group("it cost 40% less", 4), group("so yeah", 6)];
    const { groups: marked, count } = highlightKeywords(groups);
    expect(marked[0]!.words.filter((w) => w.emphasis).map((w) => w.text)).toEqual(["revenue"]);
    expect(marked[1]!.words.some((w) => w.emphasis)).toBe(false);
    expect(marked[2]!.words.filter((w) => w.emphasis).map((w) => w.text)).toEqual(["40%"]);
    expect(marked[3]!.words.some((w) => w.emphasis)).toBe(false);
    expect(count).toBe(2);
    expect(countKeywords(clearKeywords(marked))).toBe(0);
    expect(countKeywords(toggleWordEmphasis(marked, 3, 1))).toBe(3);
    expect(countKeywords(toggleWordEmphasis(marked, 0, 3))).toBe(1);
  });
});
