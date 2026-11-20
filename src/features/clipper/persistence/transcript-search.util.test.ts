import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("../../../services/projects.service", () => ({ projectsService: { getAll: vi.fn() } }));
import { clipAroundMatch, findPhrase } from "./transcript-search.util";
import { parseViralityReply } from "../editor/ai-editor/ai-virality.util";

const words = "Hello there. Our pricing changed a lot. We doubled prices, and customers stayed! That was the surprise."
  .split(" ")
  .map((text, i) => ({ text, start: i * 2, end: i * 2 + 1.5 }));

describe("transcript search", () => {
  it("finds phrases ignoring case and punctuation, prefix on the last word", () => {
    expect(findPhrase(words, "pricing")).toEqual([3]);
    expect(findPhrase(words, "doubled PRIC")).toEqual([8]);
    expect(findPhrase(words, "customers stayed")).toEqual([11]);
    expect(findPhrase(words, "nothing here")).toEqual([]);
  });
  it("makes a clip from the sentence start to about 30 s", () => {
    const span = clipAroundMatch(words, 8, 10);
    expect(words[span.from]!.text).toBe("We");
    expect(words[span.to]!.text).toBe("stayed!");
  });
});

describe("virality score", () => {
  it("parses and clamps the AI's scores", () => {
    const s = parseViralityReply('{"overall": 7.4, "hook": 11, "pacing": 6, "payoff": 0, "tip": "Cut the intro."}', "m");
    expect(s).toMatchObject({ score: 7, hook: 10, pacing: 6, payoff: 1, tip: "Cut the intro." });
  });
});
