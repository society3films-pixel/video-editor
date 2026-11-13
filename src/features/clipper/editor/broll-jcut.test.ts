import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("../../../shared/persistence/local-database.util", () => ({ localRecordGet: vi.fn(), localRecordPut: vi.fn() }));
import { audioRangesFor } from "./render-clip-edit.util";
import { suggestBroll, tagsFromName } from "./broll-library.util";
import { createInitialClipEdit } from "./clip-edit.util";
import { withImage } from "./ai-editor/ai-image.util";

describe("J/L cuts", () => {
  it("moves the sound boundary without changing its total length", () => {
    const segments = [
      { id: "a", start: 0, end: 4 },
      { id: "b", start: 10, end: 14, audioOffset: 0.5 },
      { id: "c", start: 20, end: 24, audioOffset: -0.75 },
    ];
    const ranges = audioRangesFor(segments);
    expect(ranges).toEqual([
      { start: 0, end: 3.5 },
      { start: 9.5, end: 14.75 },
      { start: 20.75, end: 24 },
    ]);
    const total = ranges.reduce((sum, r) => sum + r.end - r.start, 0);
    expect(total).toBeCloseTo(12);
  });
});

describe("B-roll library", () => {
  it("tags from file names and suggests shots where they're mentioned", () => {
    expect(tagsFromName("Guitar_closeup-02.MP4")).toEqual(["guitar", "closeup"]);
    const library = [
      { id: "1", assetId: "a", name: "guitar.mp4", kind: "video" as const, tags: ["guitar"], durationSec: 6, thumb: null },
      { id: "2", assetId: "b", name: "stage.jpg", kind: "image" as const, tags: ["stage"], durationSec: null, thumb: null },
    ];
    const words = [
      { text: "my", start: 1, end: 1.2 },
      { text: "first", start: 1.2, end: 1.5 },
      { text: "guitars", start: 1.5, end: 2 },
      { text: "on", start: 3, end: 3.2 },
      { text: "stage", start: 3.2, end: 3.6 },
      { text: "stage", start: 9, end: 9.4 },
    ];
    const suggestions = suggestBroll(createInitialClipEdit(12), words, library);
    // "stage" at 3.2 s is too close to the guitar shot; the later mention is used.
    expect(suggestions.map((s) => [s.item.id, s.outputTime])).toEqual([
      ["1", 1.5],
      ["2", 9],
    ]);
  });
  it("adds a picture to OpenAI-style messages", () => {
    const messages = withImage([{ role: "system", content: "s" }, { role: "user", content: "u" }], { mediaType: "image/jpeg", base64: "AAA" }) as Array<{ content: unknown }>;
    expect(messages[1]!.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      { type: "text", text: "u" },
    ]);
  });
});
