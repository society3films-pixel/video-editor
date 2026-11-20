import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { paperEditToClip, parsePaperEdit, quietStretches } from "./ai-editor/ai-paper-edit.util";
import { keptShare, restoreSourceRange } from "./text-cut.util";
import { createInitialClipEdit, cutSourceRange } from "./clip-edit.util";

const words = [
  ...Array.from({ length: 20 }, (_, i) => ({ text: i === 19 ? "end." : "w", start: i * 0.5, end: i * 0.5 + 0.4 })),
  ...Array.from({ length: 20 }, (_, i) => ({ text: i === 19 ? "done." : "x", start: 40 + i * 0.5, end: 40 + i * 0.5 + 0.4 })),
];

describe("paper edit", () => {
  it("marks long quiet stretches as likely music and keeps the AI's order", () => {
    const quiet = quietStretches(words);
    expect(quiet).toEqual([{ id: "M1", start: 9.9, end: 40, before: 19, after: 20 }]);
    const paper = parsePaperEdit('{"title":"Story","parts":[{"title":"Later","from":20,"to":39},{"title":"Song","music":"M1"},{"title":"Start","from":0,"to":19},{"title":"Dup","from":25,"to":30}]}', words);
    expect(paper.parts.map((p) => [p.title, p.kind])).toEqual([
      ["Later", "talk"],
      ["Song", "music"],
      ["Start", "talk"],
    ]);
    const clip = paperEditToClip(paper, 3);
    expect(clip.segments.map((s) => s.orderIndex)).toEqual([0, 1, 2]);
    expect(clip.segments[0]!.startSec).toBe(40);
    expect(clip.label).toBe("Long-form: Story");
  });
});

describe("edit by text", () => {
  it("cuts a sentence and brings it back", () => {
    const base = createInitialClipEdit(30);
    const cut = cutSourceRange(base, 10, 12);
    expect(keptShare(cut, 10.2, 11.8)).toBe(0);
    const restored = restoreSourceRange(cut, 10, 12);
    expect(restored.segments).toHaveLength(1);
    expect(restored.segments[0]).toMatchObject({ start: 0, end: 30 });
  });
});
