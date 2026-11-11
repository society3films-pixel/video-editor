/**
 * Edit model for the built-in clip editor. All functions are pure so the editor UI, the preview
 * player and the renderer share one source of truth.
 *
 * Times:
 * - `segments` are kept ranges in **source** time (seconds into the exported clip), sorted and
 *   non-overlapping. Anything outside them is cut from the output.
 * - Text overlays and fades are in **output** time (seconds into the edited result).
 * - Caption edits and framing keyframes are in source time too. They need the project's source
 *   video and are applied by re-rendering the clip from it (see save-edited-export.util).
 *   Framing belongs to the clip (saved on the project, used by every format); the editor holds a
 *   draft of it in `framing`.
 */
import type { ClipHook } from "./hook.util";
import type { ClipInsert } from "./broll.util";
import { isColorGradeActive, type ColorGrade } from "../engine/render/color-grade.util";
import type { ClipperCaptionPresetId } from "../lib/captions/caption-presets.util";
import type { ClipperCaptionPosition, ClipperCaptionSize } from "../settings/settings.util";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import {
  mergeShotBoundaries,
  shotIndexAt,
  type ClipFramingKeyframe,
  type ClipFramingTrack,
  type ClipperFramingValue,
} from "../engine/render/framing-override.util";

export const MIN_SEGMENT_SEC = 0.1;

export interface ClipEditSegment {
  id: string;
  start: number;
  end: number;
  /** Punch-in zoom for this part (1 = none); applied to the rendered export. */
  zoom?: number;
  /** Point the punch-in zooms towards (0..1 of the frame), usually the speaker's face. */
  zoomCenter?: { x: number; y: number };
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
  /** Edited caption lines; null = the AI captions as rendered. */
  captionGroups: CaptionGroup[] | null;
  /** Show/hide burned-in captions; null = follow project settings. */
  captionsVisible: boolean | null;
  /** Draft of the clip's framing track; null when the source video isn't available. */
  framing: ClipFramingTrack | null;
  /** Background music mixed under the voice. */
  music?: ClipMusic | null;
  /** Generated sound effects on cuts and punch-ins. */
  sfx?: ClipSoundEffects | null;
  /** A bar along the edge that fills up as the clip plays. */
  progressBar?: ClipProgressBar | null;
  /** Cover image (thumbnail) taken from a frame of the edited clip. */
  cover?: ClipCover | null;
  /** Clip-local time ranges where the sound is replaced by a bleep (swear words). */
  bleeps?: Array<{ start: number; end: number }>;
  /** A line played first as a teaser before the clip starts (see hook.util). */
  hook?: ClipHook | null;
  /** B-roll images and videos over parts of the edit (see broll.util). */
  inserts?: ClipInsert[];
  /** Caption look for this clip instead of the project's; null = project style. */
  captionStyle?: ClipCaptionStyle | null;
  /** Colour correction and look (rendered from the source, under the captions). */
  colorGrade?: ColorGrade | null;
}

export interface ClipCaptionStyle {
  presetId: ClipperCaptionPresetId;
  position: ClipperCaptionPosition;
  size: ClipperCaptionSize;
}

export interface ClipCover {
  /** Output time of the frame. */
  time: number;
  /** Big title drawn on the cover; empty = the frame alone. */
  title: string;
  /** Also show the cover for the first frames of the video, for platforms that use the first frame. */
  firstFrames: boolean;
}

/** How long the cover is shown at the start of the video when `firstFrames` is on. */
export const COVER_FIRST_FRAMES_SEC = 0.1;

export interface ClipMusic {
  /** Key of the audio file in the editor asset store (see editor-assets.util). */
  assetId: string;
  name: string;
  /** Music level, 0..1 of full scale. */
  volume: number;
  /** Lower the music while someone is talking. */
  duck: boolean;
  /** Where in the song to start, in seconds. */
  startSec: number;
}

export interface ClipSoundEffects {
  /** A whoosh where the edit jumps (cut out pauses or parts). */
  cuts: boolean;
  /** A low hit where a punch-in starts. */
  punchIns: boolean;
  volume: number;
}

export interface ClipProgressBar {
  position: "top" | "bottom";
  color: string;
  /** Bar thickness as a fraction of the video height. */
  thickness: number;
}

export const DEFAULT_PROGRESS_BAR: ClipProgressBar = { position: "bottom", color: "#ffd400", thickness: 0.008 };
export const DEFAULT_SOUND_EFFECTS: ClipSoundEffects = { cuts: true, punchIns: true, volume: 0.6 };

export function soundEffectsActive(edit: Pick<ClipEdit, "sfx">): boolean {
  return Boolean(edit.sfx && (edit.sfx.cuts || edit.sfx.punchIns) && edit.sfx.volume > 0);
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
    captionGroups: null,
    captionsVisible: null,
    framing: null,
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
          { ...segment, id: createEditId("seg"), end: sourceTime },
          { ...segment, id: createEditId("seg"), start: sourceTime },
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

export function clampOverlaysToDuration(edit: ClipEdit): ClipEdit {
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

/** True when the edit changes the captions, which requires re-rendering from the source. */
export function clipEditChangesCaptions(edit: ClipEdit): boolean {
  return edit.captionGroups !== null || edit.captionsVisible !== null || Boolean(edit.captionStyle) || isColorGradeActive(edit.colorGrade);
}

export function framingTracksEqual(a: ClipFramingTrack | null, b: ClipFramingTrack | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** True when cuts, audio, fades or text change the video after it is rendered. */
export function clipEditNeedsPostProcess(edit: ClipEdit, sourceDuration: number): boolean {
  const [only] = edit.segments;
  return !(
    edit.segments.length === 1 &&
    (only.zoom ?? 1) === 1 &&
    only.start <= 0.001 &&
    only.end >= sourceDuration - 0.001 &&
    edit.volume === 1 &&
    edit.fadeInSec === 0 &&
    edit.fadeOutSec === 0 &&
    edit.textOverlays.length === 0 &&
    !edit.music &&
    !soundEffectsActive(edit) &&
    !edit.progressBar &&
    !edit.cover &&
    !edit.bleeps?.length &&
    !edit.hook &&
    !edit.inserts?.length
  );
}

/** True when nothing differs from `baseline` (captions, cuts, audio, fades, text). Framing is compared separately. */
export function isClipEditUnchanged(edit: ClipEdit, sourceDuration: number): boolean {
  if (clipEditChangesCaptions(edit)) return false;
  return !clipEditNeedsPostProcess(edit, sourceDuration);
}

export function formatEditorTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function createDefaultFramingValue(): ClipperFramingValue {
  return { mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false };
}

// ---- Framing keyframe editing ------------------------------------------------------------------

/** Keyframes within this distance of the playhead count as "at" the playhead. */
export const KEYFRAME_SNAP_SEC = 0.08;

export function framingShotBoundaries(track: ClipFramingTrack, aiShotBoundaries: readonly number[]): number[] {
  return mergeShotBoundaries(aiShotBoundaries, track.extraShotBoundaries);
}

export function keyframesInShot(track: ClipFramingTrack, boundaries: readonly number[], t: number): ClipFramingKeyframe[] {
  const shot = shotIndexAt(boundaries, t);
  return track.keyframes.filter((k) => shotIndexAt(boundaries, k.t) === shot).sort((a, b) => a.t - b.t);
}

function sortKeyframes(keyframes: ClipFramingKeyframe[]): ClipFramingKeyframe[] {
  return [...keyframes].sort((a, b) => a.t - b.t);
}

/**
 * Changes the framing at the playhead. A keyframe at the playhead is updated. A shot with no
 * keyframes gets one (which then frames the whole shot); a shot with a single keyframe has
 * that keyframe updated, so simple "fix this shot" edits stay static. Only shots that already
 * animate (2+ keyframes) get a new keyframe at the playhead.
 */
export function setFramingAt(
  track: ClipFramingTrack,
  boundaries: readonly number[],
  t: number,
  value: ClipperFramingValue,
): ClipFramingTrack {
  const inShot = keyframesInShot(track, boundaries, t);
  const atPlayhead = inShot.find((k) => Math.abs(k.t - t) <= KEYFRAME_SNAP_SEC);
  const target = atPlayhead ?? (inShot.length === 1 ? inShot[0] : undefined);
  if (target) {
    // `split` is replaced, not merged, so leaving split screen really removes the panels.
    return {
      ...track,
      keyframes: track.keyframes.map((k) =>
        k.id === target.id
          ? { ...k, ...value, split: value.split, splitFollow: value.splitFollow, splitSwap: value.splitSwap, splitEmphasis: value.splitEmphasis, fit: value.fit, slowZoom: value.slowZoom, screen: value.screen }
          : k,
      ),
    };
  }
  return { ...track, keyframes: sortKeyframes([...track.keyframes, { id: createEditId("kf"), t, ...value }]) };
}

/** Adds a keyframe at the playhead holding the current framing, so the next change animates. */
export function addFramingKeyframe(track: ClipFramingTrack, t: number, value: ClipperFramingValue): ClipFramingTrack {
  if (track.keyframes.some((k) => Math.abs(k.t - t) <= KEYFRAME_SNAP_SEC)) return track;
  return { ...track, keyframes: sortKeyframes([...track.keyframes, { id: createEditId("kf"), t, ...value }]) };
}

export function removeFramingKeyframe(track: ClipFramingTrack, id: string): ClipFramingTrack {
  return { ...track, keyframes: track.keyframes.filter((k) => k.id !== id) };
}

/** Removes every keyframe in the shot at `t`, returning it to AI framing. */
export function resetShotFraming(track: ClipFramingTrack, boundaries: readonly number[], t: number): ClipFramingTrack {
  const ids = new Set(keyframesInShot(track, boundaries, t).map((k) => k.id));
  return { ...track, keyframes: track.keyframes.filter((k) => !ids.has(k.id)) };
}

/** One static keyframe per shot with `value`, replacing all existing framing. */
export function applyFramingToAllShots(
  track: ClipFramingTrack,
  boundaries: readonly number[],
  duration: number,
  value: ClipperFramingValue,
): ClipFramingTrack {
  const starts = [0, ...boundaries.filter((b) => b < duration)];
  return {
    ...track,
    keyframes: starts.map((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1]! : duration;
      return { id: createEditId("kf"), t: (start + end) / 2, ...value };
    }),
  };
}

export function addShotBoundary(track: ClipFramingTrack, t: number): ClipFramingTrack {
  return { ...track, extraShotBoundaries: mergeShotBoundaries(track.extraShotBoundaries, [t]) };
}

export function removeShotBoundary(track: ClipFramingTrack, t: number): ClipFramingTrack {
  return { ...track, extraShotBoundaries: track.extraShotBoundaries.filter((b) => Math.abs(b - t) > 0.05) };
}

/** Splits the edit's parts at every shot change. */
export function splitClipEditAtShots(edit: ClipEdit, boundaries: readonly number[]): ClipEdit {
  return boundaries.reduce((current, t) => splitClipEditAt(current, t), edit);
}

export function captionGroupText(group: CaptionGroup): string {
  return group.words.map((word) => word.text).join(" ");
}

/**
 * Replaces the wording of one caption line. Word timings are kept when the word count is
 * unchanged; otherwise the line's time is shared out by word length. Empty text removes the line.
 */
export function setCaptionGroupText(groups: readonly CaptionGroup[], index: number, text: string): CaptionGroup[] {
  const group = groups[index];
  if (!group) return [...groups];
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return groups.filter((_, i) => i !== index);

  let words: WordCue[];
  if (tokens.length === group.words.length) {
    words = group.words.map((word, i) => ({ ...word, text: tokens[i]! }));
  } else {
    const start = group.words[0]?.start ?? group.start;
    const end = group.words[group.words.length - 1]?.end ?? group.end;
    const span = Math.max(0.05, end - start);
    const weights = tokens.map((token) => token.length + 1);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    words = tokens.map((token, i) => {
      const length = (span * weights[i]!) / total;
      const word: WordCue = { text: token, start: cursor, end: cursor + length };
      cursor += length;
      return word;
    });
  }
  return groups.map((item, i) => (i === index ? { ...item, words } : item));
}

/**
 * Removes a source-time range from the kept parts, splitting parts as needed. Refuses to cut the
 * whole clip (returns the edit unchanged).
 */
export function cutSourceRange(edit: ClipEdit, start: number, end: number): ClipEdit {
  if (end - start < 0.01) return edit;
  const segments = edit.segments.flatMap((segment) => {
    if (end <= segment.start || start >= segment.end) return [segment];
    const parts: ClipEditSegment[] = [];
    if (start - segment.start >= MIN_SEGMENT_SEC) parts.push({ ...segment, id: createEditId("seg"), end: start });
    if (segment.end - end >= MIN_SEGMENT_SEC) parts.push({ ...segment, id: createEditId("seg"), start: end });
    return parts;
  });
  if (segments.length === 0) return edit;
  return clampOverlaysToDuration({ ...edit, segments });
}

/** Zooms the kept footage between two source times (splitting parts at the edges). */
export function zoomSourceRange(edit: ClipEdit, start: number, end: number, zoom: number): ClipEdit {
  const split = splitClipEditAt(splitClipEditAt(edit, start), end);
  return {
    ...split,
    segments: split.segments.map((segment) =>
      segment.start >= start - 0.01 && segment.end <= end + 0.01
        ? { ...segment, zoom: zoom > 1.001 ? Math.min(2, zoom) : undefined }
        : segment,
    ),
  };
}
