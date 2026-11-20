import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { findInterviewQuestions, removeQuestions } from "./interviewer.util";
import { createInitialClipEdit } from "./clip-edit.util";

function sentence(text: string, start: number) {
  return text.split(" ").map((w, i) => ({ text: w, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
}
const words = [
  ...sentence("What got you into jazz?", 0),
  ...sentence("My dad played records every night.", 3),
  ...sentence("You know what I mean?", 8),
  ...sentence("How did the band start?", 12),
  ...sentence("We met at school.", 15),
];
// The on-screen musician's mouth moves while they answer (and during their own "you know what I mean?").
const activity = Array.from({ length: 180 }, (_, i) => {
  const t = i * 0.1;
  const musician = (t >= 3 && t < 6) || (t >= 8 && t < 10) || (t >= 15 && t < 17);
  return { t, activity: musician ? 10 : 1.5 };
});

describe("interviewer questions", () => {
  it("finds questions said off camera, not the musician's own", () => {
    expect(findInterviewQuestions(words, activity).map((q) => [q.text, q.evidence])).toEqual([
      ["What got you into jazz?", "off-camera"],
      ["How did the band start?", "off-camera"],
    ]);
  });
  it("falls back to wording without face data", () => {
    expect(findInterviewQuestions(words, null).map((q) => q.text)).toContain("You know what I mean?");
  });
  it("cuts them and can show them as cards over the answer", () => {
    const questions = findInterviewQuestions(words, activity);
    const edit = removeQuestions(createInitialClipEdit(18), questions, true);
    expect(edit.textOverlays.map((o) => o.text)).toEqual(["What got you into jazz?", "How did the band start?"]);
    const kept = (t: number) => edit.segments.some((s) => t >= s.start && t < s.end);
    expect(kept(0.5)).toBe(false);
    expect(kept(4)).toBe(true);
    expect(kept(12.5)).toBe(false);
  });
});
