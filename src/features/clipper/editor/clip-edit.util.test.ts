import { describe, expect, it } from "vitest";
import {
  createInitialClipEdit,
  createTextOverlay,
  getFadeFactor,
  getOutputDuration,
  isClipEditUnchanged,
  outputToSourceTime,
  removeClipEditSegment,
  resetClipEditCuts,
  sourceToOutputTime,
  splitClipEditAt,
  trimClipEditSegment,
} from "./clip-edit.util";

describe("clip edit model", () => {
  it("splits and removes a middle section", () => {
    let edit = createInitialClipEdit(10);
    edit = splitClipEditAt(edit, 3);
    edit = splitClipEditAt(edit, 6);
    expect(edit.segments.map((s) => [s.start, s.end])).toEqual([[0, 3], [3, 6], [6, 10]]);

    edit = removeClipEditSegment(edit, edit.segments[1].id);
    expect(edit.segments.map((s) => [s.start, s.end])).toEqual([[0, 3], [6, 10]]);
    expect(getOutputDuration(edit.segments)).toBe(7);
  });

  it("ignores splits at an edge and never removes the last part", () => {
    const edit = createInitialClipEdit(10);
    expect(splitClipEditAt(edit, 0.05)).toBe(edit);
    expect(removeClipEditSegment(edit, edit.segments[0].id)).toBe(edit);
  });

  it("maps between source and output time across cuts", () => {
    let edit = splitClipEditAt(splitClipEditAt(createInitialClipEdit(10), 3), 6);
    edit = removeClipEditSegment(edit, edit.segments[1].id);
    expect(sourceToOutputTime(edit.segments, 2)).toBe(2);
    expect(sourceToOutputTime(edit.segments, 4)).toBe(3);
    expect(sourceToOutputTime(edit.segments, 7)).toBe(4);
    expect(outputToSourceTime(edit.segments, 4)).toBe(7);
    expect(outputToSourceTime(edit.segments, 99)).toBe(10);
  });

  it("clamps trims to neighbours and minimum length", () => {
    let edit = splitClipEditAt(createInitialClipEdit(10), 5);
    edit = removeClipEditSegment(splitClipEditAt(edit, 7), splitClipEditAt(edit, 7).segments[1].id);
    const [first, second] = edit.segments;
    const grown = trimClipEditSegment(edit, first.id, "end", 9, 10);
    expect(grown.segments[0].end).toBe(second.start);
    const shrunk = trimClipEditSegment(edit, first.id, "end", -5, 10);
    expect(shrunk.segments[0].end).toBeCloseTo(0.1);
    const trimmedStart = trimClipEditSegment(edit, first.id, "start", 1.5, 10);
    expect(trimmedStart.segments[0].start).toBe(1.5);
  });

  it("keeps text overlays inside the new duration after a trim", () => {
    let edit = createInitialClipEdit(10);
    edit = { ...edit, textOverlays: [{ ...createTextOverlay(8, 10), end: 10 }] };
    edit = trimClipEditSegment(edit, edit.segments[0].id, "end", 6, 10);
    expect(edit.textOverlays).toHaveLength(0);
  });

  it("computes fades and detects unchanged edits", () => {
    const edit = { ...createInitialClipEdit(10), fadeInSec: 2, fadeOutSec: 1 };
    expect(getFadeFactor(edit, 0, 10)).toBe(0);
    expect(getFadeFactor(edit, 1, 10)).toBe(0.5);
    expect(getFadeFactor(edit, 5, 10)).toBe(1);
    expect(getFadeFactor(edit, 9.5, 10)).toBe(0.5);
    expect(isClipEditUnchanged(edit, 10)).toBe(false);
    const split = splitClipEditAt(createInitialClipEdit(10), 4);
    expect(isClipEditUnchanged(split, 10)).toBe(false);
    expect(isClipEditUnchanged(resetClipEditCuts(split, 10), 10)).toBe(true);
  });
});
