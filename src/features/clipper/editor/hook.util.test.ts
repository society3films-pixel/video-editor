import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { pickHookLocally, renderSegmentsFor, splitSentences } from "./hook.util";
import { soundEffectEvents } from "./audio-extras.util";

function words(text: string) {
  let t = 0;
  return text.split(" ").map((w) => {
    const word = { text: w, start: t, end: t + 0.3 };
    t += 0.35;
    return word;
  });
}

describe("hook", () => {
  const transcript = words(
    "so today I want to talk about our year. we tried a lot of things. in the end we made $50,000 in three months! and it changed everything for us.",
  );
  it("splits sentences", () => {
    expect(splitSentences(transcript).map((s) => s.text)[2]).toBe("in the end we made $50,000 in three months!");
  });
  it("picks the strongest later line", () => {
    const hook = pickHookLocally(transcript, 12)!;
    expect(hook.text).toBe("in the end we made $50,000 in three months!");
  });
  it("renders the hook first and adds a whoosh where it jumps back", () => {
    const edit = { segments: [{ id: "a", start: 0, end: 12 }], hook: { start: 5, end: 8, text: "x" } };
    expect(renderSegmentsFor(edit).map((s) => [s.start, s.end])).toEqual([
      [5, 8],
      [0, 12],
    ]);
    expect(soundEffectEvents(renderSegmentsFor(edit), { cuts: true, punchIns: false })).toEqual([{ t: 3, kind: "whoosh" }]);
  });
});
