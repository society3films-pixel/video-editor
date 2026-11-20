import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { fileKey, readyFiles, videoMimeType } from "./watch-folder.util";

describe("watch folder", () => {
  const now = 1_000_000;
  const file = (path: string, size: number, age: number) => ({ path, name: path, size, modifiedMs: now - age });
  it("only takes new files that have finished copying", () => {
    const files = [file("a.mp4", 100, 60_000), file("b.mp4", 200, 60_000), file("c.mp4", 300, 5_000), file("d.mp4", 400, 60_000)];
    const previous = new Map([["a.mp4", 100], ["b.mp4", 150], ["c.mp4", 300], ["d.mp4", 400]]);
    const processed = new Set([fileKey(files[3]!)]);
    // a: stable and old → ready; b: still growing; c: too recent; d: already done.
    expect(readyFiles(files, previous, processed, now).map((f) => f.path)).toEqual(["a.mp4"]);
  });
  it("maps extensions to MIME types", () => {
    expect(videoMimeType("x.MOV")).toBe("video/quicktime");
    expect(videoMimeType("x.mp4")).toBe("video/mp4");
  });
});
