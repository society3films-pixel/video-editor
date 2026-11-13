/** Text-based editing: cut or restore whole sentences by their words' times. */
import { createEditId, MIN_SEGMENT_SEC, type ClipEdit, type ClipEditSegment } from "./clip-edit.util";

/** Adds a source range back to the kept parts (merging with neighbours; existing parts keep their settings). */
export function restoreSourceRange(edit: ClipEdit, start: number, end: number): ClipEdit {
  if (end - start < 0.01) return edit;
  const sorted = [...edit.segments].sort((a, b) => a.start - b.start);
  const merged: ClipEditSegment[] = [];
  let added: ClipEditSegment | null = { id: createEditId("seg"), start, end };
  for (const segment of sorted) {
    if (added && segment.end >= added.start - 0.05 && segment.start <= added.end + 0.05) {
      // Overlaps or touches: extend the existing part rather than adding a new one.
      added = { ...segment, start: Math.min(segment.start, added.start), end: Math.max(segment.end, added.end) };
      continue;
    }
    if (added && segment.start > added.end) {
      merged.push(added);
      added = null;
    }
    merged.push(segment);
  }
  if (added) merged.push(added);
  // Merging can make two neighbours overlap; fold them.
  const folded: ClipEditSegment[] = [];
  for (const segment of merged.sort((a, b) => a.start - b.start)) {
    const last = folded[folded.length - 1];
    if (last && segment.start <= last.end + 0.001) last.end = Math.max(last.end, segment.end);
    else folded.push({ ...segment });
  }
  return { ...edit, segments: folded.filter((s) => s.end - s.start >= MIN_SEGMENT_SEC) };
}

/** Share (0..1) of a source range that's kept. */
export function keptShare(edit: ClipEdit, start: number, end: number): number {
  const length = Math.max(1e-6, end - start);
  const kept = edit.segments.reduce((sum, s) => sum + Math.max(0, Math.min(end, s.end) - Math.max(start, s.start)), 0);
  return Math.min(1, kept / length);
}
