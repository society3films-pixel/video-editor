import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import {
  addEmojiAutomatically,
  applyTranslation,
  emojiForWord,
  isSwearWord,
  maskSwearWords,
  maskWord,
  parseTranslation,
  swearBleepRanges,
} from "./caption-extras.util";

const group = (text: string, start: number) => {
  const words = text.split(" ").map((w, i) => ({ text: w, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
  return { words, start, end: start + words.length * 0.3 };
};

describe("emoji", () => {
  it("maps words to emoji", () => {
    expect(emojiForWord("money,")).toBe("💰");
    expect(emojiForWord("Fire!")).toBe("🔥");
    expect(emojiForWord("the")).toBeNull();
  });
  it("adds at most every other line", () => {
    const { groups, count } = addEmojiAutomatically([group("we made money", 0), group("so much money", 1), group("it was crazy", 2)]);
    expect(count).toBe(2);
    expect(groups.map((g) => g.words.find((w) => w.emoji)?.emoji ?? null)).toEqual(["💰", null, "🤯"]);
  });
});

describe("swear words", () => {
  it("detects and masks without false positives", () => {
    expect(isSwearWord("Fucking")).toBe(true);
    expect(isSwearWord("bullshit.")).toBe(true);
    expect(isSwearWord("class")).toBe(false);
    expect(isSwearWord("cocktail")).toBe(false);
    expect(maskWord("fucking,")).toBe("f*****g,");
    expect(maskWord("ass")).toBe("a**");
  });
  it("masks captions and finds bleep ranges", () => {
    const { groups, count } = maskSwearWords([group("this is shit man", 0)]);
    expect(count).toBe(1);
    expect(groups[0]!.words[2]!.text).toBe("s**t");
    expect(swearBleepRanges(groups[0]!.words)).toEqual([{ start: 0.57, end: 0.88 }]);
  });
});

describe("translation", () => {
  it("parses the reply and keeps line timing", () => {
    const groups = [group("hello there", 0), group("how are you", 1)];
    const lines = parseTranslation('```json\n{"lines":["hola","¿cómo estás?"]}\n```', 2);
    const translated = applyTranslation(groups, lines);
    expect(translated.map((g) => g.words.map((w) => w.text).join(" "))).toEqual(["hola", "¿cómo estás?"]);
    expect(translated[1]!.start).toBe(1);
    expect(() => parseTranslation('{"lines":["one"]}', 2)).toThrow(/1 lines for 2/);
  });
});
