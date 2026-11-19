import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("../../../shared/persistence/local-database.util", () => ({
  localRecordGet: vi.fn(),
  localRecordPut: vi.fn(),
}));
import { applyTemplate, templateFromEdit } from "./edit-templates.util";
import {
  clipEditChangesCaptions,
  createInitialClipEdit,
} from "./clip-edit.util";
import { applyEditToFrameContext } from "./clip-editor-source.util";

const groups = [
  {
    words: [
      { text: "we", start: 0, end: 0.3 },
      { text: "made", start: 0.3, end: 0.6 },
      { text: "revenue", start: 0.6, end: 1 },
    ],
    start: 0,
    end: 1,
  },
];

describe("templates", () => {
  it("captures a look and applies it to another clip", () => {
    const source = {
      ...createInitialClipEdit(20),
      captionStyle: {
        presetId: "beast" as never,
        position: "center" as const,
        size: "large" as const,
      },
      progressBar: {
        position: "top" as const,
        color: "#ff0000",
        thickness: 0.01,
      },
      fadeOutSec: 1,
      captionGroups: [
        {
          ...groups[0]!,
          words: groups[0]!.words.map((w, i) =>
            i === 2 ? { ...w, emphasis: true, emoji: "📈" } : w,
          ),
        },
      ],
    };
    const template = templateFromEdit("Bold", source);
    expect(template).toMatchObject({
      name: "Bold",
      keywords: true,
      emoji: true,
      hook: false,
      fadeOutSec: 1,
    });
    const applied = applyTemplate(createInitialClipEdit(10), template, {
      captionGroups: groups,
      words: groups[0]!.words,
      duration: 10,
    });
    expect(applied.captionStyle).toEqual(source.captionStyle);
    expect(applied.progressBar).toEqual(source.progressBar);
    expect(applied.captionGroups![0]!.words[2]).toMatchObject({
      emphasis: true,
      emoji: "📈",
    });
    expect(clipEditChangesCaptions(applied)).toBe(true);
  });
  it("overrides the project's caption style for the clip only", () => {
    const base = {
      settings: {
        captions: {
          enabled: true,
          presetId: "capicola-box",
          position: "bottom",
          size: "medium",
          wordsPerGroup: 4,
        },
      },
      captionGroups: [],
    } as never;
    const edit = {
      ...createInitialClipEdit(10),
      captionStyle: {
        presetId: "beast" as never,
        position: "top" as const,
        size: "small" as const,
      },
    };
    const context = applyEditToFrameContext(base, edit) as unknown as {
      settings: { captions: Record<string, unknown> };
    };
    expect(context.settings.captions).toMatchObject({
      presetId: "beast",
      position: "top",
      size: "small",
      wordsPerGroup: 4,
      enabled: true,
    });
  });
});

describe("built-in trending looks", () => {
  it("come first, can't be deleted or overwritten, and set pacing on an uncut clip", async () => {
    const {
      loadTemplates,
      saveTemplate,
      BUILT_IN_TEMPLATES,
      applyTemplate,
      templateFromEdit,
    } = await import("./edit-templates.util");
    const { createInitialClipEdit } = await import("./clip-edit.util");
    const db = await import("../../../shared/persistence/local-database.util");
    let stored: unknown = null;
    vi.mocked(db.localRecordGet).mockImplementation(
      async () => stored as never,
    );
    vi.mocked(db.localRecordPut).mockImplementation(
      async (_n, _k, _p, payload) => {
        stored = payload;
        return payload as never;
      },
    );
    const list = await loadTemplates();
    expect(
      list.slice(0, BUILT_IN_TEMPLATES.length).every((t) => t.builtIn),
    ).toBe(true);
    const viral = BUILT_IN_TEMPLATES.find(
      (t) => t.name === "Viral talking head",
    )!;
    // Words with long pauses between them: jump cuts remove the pauses, punch-ins alternate.
    const words = Array.from({ length: 12 }, (_, i) => ({
      text: `w${i}`,
      start: i * 2,
      end: i * 2 + 0.6,
    }));
    const edit = applyTemplate(createInitialClipEdit(24), viral, {
      captionGroups: [],
      words,
      duration: 24,
    });
    expect(edit.segments.length).toBeGreaterThan(1);
    expect(edit.segments.some((s) => (s.zoom ?? 1) > 1)).toBe(true);
    expect(edit.captionStyle?.presetId).toBe("beast");
    // The live-performance look never cuts.
    const live = BUILT_IN_TEMPLATES.find((t) => t.name === "Live performance")!;
    expect(
      applyTemplate(createInitialClipEdit(24), live, {
        captionGroups: [],
        words,
        duration: 24,
      }).segments,
    ).toHaveLength(1);
    // Saving your own look under a built-in name keeps the built-in.
    const saved = await saveTemplate(
      templateFromEdit("Podcast clip", createInitialClipEdit(10)),
    );
    expect(saved.filter((t) => t.name === "Podcast clip")).toHaveLength(1);
    expect(
      saved.some((t) => t.name === "Podcast clip (mine)" && !t.builtIn),
    ).toBe(true);
  });
});
