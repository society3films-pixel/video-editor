import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
const save = vi.fn(async () => ({ kind: "saved", fileName: "x.mp4" }));
vi.mock("./save-edited-export.util", () => ({
  saveEditedClipperExport: (...args: unknown[]) => save(...(args as [])),
}));
vi.mock("./color-measure.util", () => ({ measureClipColor: async () => null }));
vi.mock("../../../shared/persistence/local-database.util", () => ({
  localRecordGet: vi.fn(),
  localRecordPut: vi.fn(),
}));

import { renderClipsWithLook } from "./render-with-look.util";
import { BUILT_IN_TEMPLATES } from "./edit-templates.util";
import type { ClipEditorSource } from "./clip-editor-source.util";

const words = Array.from({ length: 12 }, (_, i) => ({
  text: `w${i}`,
  start: i * 2,
  end: i * 2 + 0.6,
}));
const source = (formatId: string) =>
  ({
    duration: 24,
    framingTrack: null,
    formatDef: { id: formatId, label: formatId, platform: "tiktok" },
    outputSize: { width: 1080, height: 1920 },
    rangeVideoUrl: "blob:x",
    clip: {
      startSec: 100,
      endSec: 124,
      words,
      segments: [{ startSec: 100, endSec: 124 }],
    },
    frameContext: { captionGroups: [] },
  }) as unknown as ClipEditorSource;

describe("render with a look", () => {
  it("renders every selected clip and format from the source with the look applied", async () => {
    const look = BUILT_IN_TEMPLATES.find(
      (t) => t.name === "Viral talking head",
    )!;
    const progress: string[] = [];
    const outcome = await renderClipsWithLook(
      "p1",
      look,
      { 0: ["tiktok-9-16", "square"], 2: ["tiktok-9-16"] },
      (clipIndex, formatId) =>
        clipIndex === 2 && formatId === "nope" ? null : source(formatId),
      {
        onProgress: (done, total, label) =>
          progress.push(`${done}/${total} ${label}`),
      },
    );
    expect(outcome).toEqual({ saved: 3, failed: [] });
    expect(save).toHaveBeenCalledTimes(3);
    const [projectId, base, edit, duration, options] = save.mock
      .calls[0]! as unknown as [
      string,
      { id: string },
      { captionStyle: { presetId: string }; segments: unknown[] },
      number,
      { needsSourceRender: boolean },
    ];
    expect(projectId).toBe("p1");
    expect(base.id).toBe("source:0:tiktok-9-16");
    expect(edit.captionStyle.presetId).toBe("beast");
    expect(edit.segments.length).toBeGreaterThan(1);
    expect(duration).toBe(24);
    expect(options.needsSourceRender).toBe(true);
    expect(progress.at(-1)).toBe("3/3 Done");
  });
});
