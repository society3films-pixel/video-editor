import { describe, expect, it } from "vitest";
import {
  captionGroupText,
  clipEditNeedsPostProcess,
  clipEditChangesCaptions,
  createDefaultFramingValue,
  setFramingAt,
  addFramingKeyframe,
  applyFramingToAllShots,
  resetShotFraming,
  splitClipEditAtShots,
  setCaptionGroupText,
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

describe("caption and framing edits", () => {
  const groups = [
    { start: 0, end: 1, words: [{ text: "hello", start: 0, end: 0.5 }, { text: "wrold", start: 0.5, end: 1 }] },
    { start: 1, end: 2, words: [{ text: "bye", start: 1, end: 2 }] },
  ];

  it("keeps word timings when the word count is unchanged", () => {
    const next = setCaptionGroupText(groups, 0, "hello world");
    expect(next[0].words).toEqual([
      { text: "hello", start: 0, end: 0.5 },
      { text: "world", start: 0.5, end: 1 },
    ]);
    expect(captionGroupText(next[0])).toBe("hello world");
    expect(groups[0].words[1].text).toBe("wrold");
  });

  it("spreads new words across the line and removes empty lines", () => {
    const longer = setCaptionGroupText(groups, 1, "see you soon");
    expect(longer[1].words).toHaveLength(3);
    expect(longer[1].words[0].start).toBe(1);
    expect(longer[1].words[2].end).toBeCloseTo(2);
    expect(setCaptionGroupText(groups, 1, "   ")).toHaveLength(1);
  });

  it("flags caption changes and post-processing separately", () => {
    const base = createInitialClipEdit(10);
    expect(clipEditChangesCaptions(base)).toBe(false);
    expect(clipEditChangesCaptions({ ...base, captionsVisible: false })).toBe(true);
    expect(clipEditNeedsPostProcess(base, 10)).toBe(false);
    expect(clipEditNeedsPostProcess(splitClipEditAt(base, 4), 10)).toBe(true);
    expect(isClipEditUnchanged({ ...base, captionsVisible: false }, 10)).toBe(false);
  });
});

describe("framing keyframe editing", () => {
  const empty = { keyframes: [], extraShotBoundaries: [] };
  const boundaries = [5];
  const zoomed = { ...createDefaultFramingValue(), zoom: 2 };

  it("keeps one static keyframe per shot until you add another", () => {
    let track = setFramingAt(empty, boundaries, 1, zoomed);
    expect(track.keyframes).toHaveLength(1);
    track = setFramingAt(track, boundaries, 3, { ...zoomed, zoom: 1.5 });
    expect(track.keyframes).toHaveLength(1);
    expect(track.keyframes[0].zoom).toBe(1.5);
    track = setFramingAt(track, boundaries, 7, zoomed);
    expect(track.keyframes).toHaveLength(2);
  });

  it("animates once a second keyframe is added", () => {
    let track = setFramingAt(empty, boundaries, 1, zoomed);
    track = addFramingKeyframe(track, 4, zoomed);
    track = setFramingAt(track, boundaries, 4, { ...zoomed, x: 0.5 });
    expect(track.keyframes.map((k) => [k.t, k.x])).toEqual([[1, 0], [4, 0.5]]);
  });

  it("resets a shot and applies one framing to every shot", () => {
    let track = setFramingAt(empty, boundaries, 1, zoomed);
    track = setFramingAt(track, boundaries, 7, zoomed);
    expect(resetShotFraming(track, boundaries, 2).keyframes.map((k) => k.t)).toEqual([7]);
    const all = applyFramingToAllShots(empty, [5, 8], 10, zoomed);
    expect(all.keyframes.map((k) => k.t)).toEqual([2.5, 6.5, 9]);
  });

  it("splits parts at shot changes", () => {
    const split = splitClipEditAtShots(createInitialClipEdit(10), [3, 7]);
    expect(split.segments.map((s) => [s.start, s.end])).toEqual([[0, 3], [3, 7], [7, 10]]);
  });
});
