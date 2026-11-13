import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("../../../shared/persistence/local-database.util", () => ({ localRecordGet: vi.fn(), localRecordPut: vi.fn() }));
import { applyTemplate, templateFromEdit } from "./edit-templates.util";
import { clipEditChangesCaptions, createInitialClipEdit } from "./clip-edit.util";
import { applyEditToFrameContext } from "./clip-editor-source.util";

const groups = [{ words: [{ text: "we", start: 0, end: 0.3 }, { text: "made", start: 0.3, end: 0.6 }, { text: "revenue", start: 0.6, end: 1 }], start: 0, end: 1 }];

describe("templates", () => {
  it("captures a look and applies it to another clip", () => {
    const source = {
      ...createInitialClipEdit(20),
      captionStyle: { presetId: "beast" as never, position: "center" as const, size: "large" as const },
      progressBar: { position: "top" as const, color: "#ff0000", thickness: 0.01 },
      fadeOutSec: 1,
      captionGroups: [{ ...groups[0]!, words: groups[0]!.words.map((w, i) => (i === 2 ? { ...w, emphasis: true, emoji: "📈" } : w)) }],
    };
    const template = templateFromEdit("Bold", source);
    expect(template).toMatchObject({ name: "Bold", keywords: true, emoji: true, hook: false, fadeOutSec: 1 });
    const applied = applyTemplate(createInitialClipEdit(10), template, { captionGroups: groups, words: groups[0]!.words, duration: 10 });
    expect(applied.captionStyle).toEqual(source.captionStyle);
    expect(applied.progressBar).toEqual(source.progressBar);
    expect(applied.captionGroups![0]!.words[2]).toMatchObject({ emphasis: true, emoji: "📈" });
    expect(clipEditChangesCaptions(applied)).toBe(true);
  });
  it("overrides the project's caption style for the clip only", () => {
    const base = { settings: { captions: { enabled: true, presetId: "capicola-box", position: "bottom", size: "medium", wordsPerGroup: 4 } }, captionGroups: [] } as never;
    const edit = { ...createInitialClipEdit(10), captionStyle: { presetId: "beast" as never, position: "top" as const, size: "small" as const } };
    const context = applyEditToFrameContext(base, edit) as unknown as { settings: { captions: Record<string, unknown> } };
    expect(context.settings.captions).toMatchObject({ presetId: "beast", position: "top", size: "small", wordsPerGroup: 4, enabled: true });
  });
});
