/**
 * Edit model for the built-in clip editor. All functions are pure so the editor UI, the preview
 * player and the renderer share one source of truth.
 *
 * Times:
 * - `segments` are kept ranges in **source** time (seconds into the exported clip), sorted and
 *   non-overlapping. Anything outside them is cut from the output.
 * - Text overlays and fades are in **output** time (seconds into the edited result).
 */

export const MIN_SEGMENT_SEC = 0.1;

export interface ClipEditSegment {
  id: string;
  start: number;
  end: number;
}

export type ClipTextPosition = "top" | "middle" | "bottom";

export interface ClipTextOverlay {
  id: string;
  text: string;
  start: number;
  end: number;
  position: ClipTextPosition;
  /** Font size as a fraction of the frame height. */
  size: number;
  color: string;
  /** Draws a dark rounded box behind the text instead of an outline. */
  background: boolean;
}

export interface ClipEdit {
  segments: ClipEditSegment[];
  /** Linear gain, 0 (mute) to 2 (+6 dB). */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  textOverlays: ClipTextOverlay[];
}

let idCounter = 0;
export function createEditId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createInitialClipEdit(durationSec: number): ClipEdit {
  return {
    segments: [{ id: createEditId("seg"), start: 0, end: Math.max(0, durationSec) }],
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    textOverlays: [],
  };
}

export function getOutputDuration(segments: readonly ClipEditSegment[]): number {
  return segments.reduce((total, segment) => total + Math.max(0, segment.end - segment.start), 0);
}

export function findSegmentAt(
  segments: readonly ClipEditSegment[],
  sourceTime: number,
): ClipEditSegment | undefined {
  return segments.find((segment) => sourceTime >= segment.start && sourceTime < segment.end);
}

/** First kept segment that starts at or after `sourceTime`, used to skip over cut regions. */
export function findNextSegment(
  segments: readonly ClipEditSegment[],
  sourceTime: number,
): ClipEditSegment | undefined {
  return segments.find((segment) => segment.start >= sourceTime - 1e-6);
}

/** Maps a source time to output time. Times inside a cut snap to the start of the next kept part. */
export function sourceToOutputTime(segments: readonly ClipEditSegment[], sourceTime: number): number {
  let offset = 0;
  for (const segment of segments) {
    if (sourceTime < segment.start) return offset;
    if (sourceTime < segment.end) return offset + (sourceTime - segment.start);
    offset += segment.end - segment.start;
  }
  return offset;
}

export function outputToSourceTime(segments: readonly ClipEditSegment[], outputTime: number): number {
  let offset = 0;
  for (const segment of segments) {
    const length = segment.end - segment.start;
    if (outputTime < offset + length) return segment.start + Math.max(0, outputTime - offset);
    offset += length;
  }
  const last = segments[segments.length - 1];
  return last ? last.end : 0;
}

/** Splits the segment under `sourceTime` in two. No-op when too close to an edge or in a cut. */
export function splitClipEditAt(edit: ClipEdit, sourceTime: number): ClipEdit {
  const target = findSegmentAt(edit.segments, sourceTime);
  if (!target) return edit;
  if (sourceTime - target.start < MIN_SEGMENT_SEC || target.end - sourceTime < MIN_SEGMENT_SEC) {
    return edit;
  }
  const segments = edit.segments.flatMap((segment) =>
    segment.id === target.id
      ? [
          { id: createEditId("seg"), start: segment.start, end: sourceTime },
          { id: createEditId("seg"), start: sourceTime, end: segment.end },
        ]
      : [segment],
  );
  return { ...edit, segments };
}

/** Removes a kept segment from the output. The last remaining segment cannot be removed. */
export function removeClipEditSegment(edit: ClipEdit, segmentId: string): ClipEdit {
  if (edit.segments.length <= 1) return edit;
  const segments = edit.segments.filter((segment) => segment.id !== segmentId);
  return clampOverlaysToDuration({ ...edit, segments });
}

/**
 * Moves one edge of a segment. Edges are clamped to the neighbouring segments, the source
 * bounds and a minimum segment length.
 */
export function trimClipEditSegment(
  edit: ClipEdit,
  segmentId: string,
  edge: "start" | "end",
  sourceTime: number,
  sourceDuration: number,
): ClipEdit {
  const index = edit.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return edit;
  const segment = edit.segments[index];
  const previous = edit.segments[index - 1];
  const next = edit.segments[index + 1];
  const updated =
    edge === "start"
      ? { ...segment, start: clamp(sourceTime, previous ? previous.end : 0, segment.end - MIN_SEGMENT_SEC) }
      : {
          ...segment,
          end: clamp(sourceTime, segment.start + MIN_SEGMENT_SEC, next ? next.start : sourceDuration),
        };
  const segments = edit.segments.map((item) => (item.id === segmentId ? updated : item));
  return clampOverlaysToDuration({ ...edit, segments });
}

/** Restores the full source as a single segment, keeping audio, fades and text. */
export function resetClipEditCuts(edit: ClipEdit, sourceDuration: number): ClipEdit {
  return { ...edit, segments: createInitialClipEdit(sourceDuration).segments };
}

function clampOverlaysToDuration(edit: ClipEdit): ClipEdit {
  const duration = getOutputDuration(edit.segments);
  const textOverlays = edit.textOverlays
    .map((overlay) => ({
      ...overlay,
      start: clamp(overlay.start, 0, duration),
      end: clamp(overlay.end, 0, duration),
    }))
    .filter((overlay) => overlay.end - overlay.start > 0.01);
  const fadeLimit = duration / 2;
  return {
    ...edit,
    textOverlays,
    fadeInSec: Math.min(edit.fadeInSec, fadeLimit),
    fadeOutSec: Math.min(edit.fadeOutSec, fadeLimit),
  };
}

export function createTextOverlay(startSec: number, outputDuration: number): ClipTextOverlay {
  const start = clamp(startSec, 0, Math.max(0, outputDuration - MIN_SEGMENT_SEC));
  return {
    id: createEditId("text"),
    text: "Your text",
    start,
    end: Math.min(outputDuration, start + 3),
    position: "top",
    size: 0.06,
    color: "#FFFFFF",
    background: true,
  };
}

/** Combined fade multiplier (0..1) at an output time. */
export function getFadeFactor(edit: Pick<ClipEdit, "fadeInSec" | "fadeOutSec">, outputTime: number, outputDuration: number): number {
  let factor = 1;
  if (edit.fadeInSec > 0) factor = Math.min(factor, clamp(outputTime / edit.fadeInSec, 0, 1));
  if (edit.fadeOutSec > 0) {
    factor = Math.min(factor, clamp((outputDuration - outputTime) / edit.fadeOutSec, 0, 1));
  }
  return factor;
}

export function isClipEditUnchanged(edit: ClipEdit, sourceDuration: number): boolean {
  const [only] = edit.segments;
  return (
    edit.segments.length === 1 &&
    only.start <= 0.001 &&
    only.end >= sourceDuration - 0.001 &&
    edit.volume === 1 &&
    edit.fadeInSec === 0 &&
    edit.fadeOutSec === 0 &&
    edit.textOverlays.length === 0
  );
}

export function formatEditorTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}
