import type { CaptionGroup } from "../lib/media/transcription-export.util";
import { MIN_SEGMENT_SEC, type ClipEdit, type ClipEditSegment, type ClipTextOverlay } from "./clip-edit.util";

/**
 * The part of a clip edit saved with an edited export. Framing is not included: it belongs to
 * the clip and is saved on the project (see pipeline/clip-framing.util).
 */
export type PersistedClipEdit = Omit<ClipEdit, "framing">;

export function toPersistedClipEdit(edit: ClipEdit): PersistedClipEdit {
  const { framing: _framing, ...rest } = edit;
  void _framing;
  return rest;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates a saved edit against the clip's duration; returns null when it can't be used. */
export function fromPersistedClipEdit(raw: unknown, duration: number): Omit<ClipEdit, "framing"> | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PersistedClipEdit>;
  const segments = (Array.isArray(value.segments) ? value.segments : [])
    .filter((s): s is ClipEditSegment => Boolean(s) && isFiniteNumber(s.start) && isFiniteNumber(s.end) && typeof s.id === "string")
    .map((s) => ({ id: s.id, start: Math.max(0, s.start), end: Math.min(duration, s.end) }))
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SEC)
    .sort((a, b) => a.start - b.start);
  if (segments.length === 0) return null;
  const textOverlays = (Array.isArray(value.textOverlays) ? value.textOverlays : []).filter(
    (o): o is ClipTextOverlay => Boolean(o) && typeof o.text === "string" && isFiniteNumber(o.start) && isFiniteNumber(o.end),
  );
  const captionGroups = Array.isArray(value.captionGroups) ? (value.captionGroups as CaptionGroup[]) : null;
  return {
    segments,
    volume: isFiniteNumber(value.volume) ? Math.min(2, Math.max(0, value.volume)) : 1,
    fadeInSec: isFiniteNumber(value.fadeInSec) ? Math.max(0, value.fadeInSec) : 0,
    fadeOutSec: isFiniteNumber(value.fadeOutSec) ? Math.max(0, value.fadeOutSec) : 0,
    textOverlays,
    captionGroups,
    captionsVisible: typeof value.captionsVisible === "boolean" ? value.captionsVisible : null,
  };
}
