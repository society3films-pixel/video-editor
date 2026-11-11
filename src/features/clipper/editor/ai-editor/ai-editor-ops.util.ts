/**
 * Operations the AI editor can ask for, how its reply is parsed, and how operations are applied
 * to an edit with the same functions the editor's own controls use.
 *
 * Words are referred to by their index in the clip's word list (clip-local time), so the model
 * never has to guess timestamps.
 */
import { clearKeywords, highlightKeywords, toggleWordEmphasis } from "../caption-keywords.util";
import type { CaptionGroup, WordCue } from "../../lib/media/transcription-export.util";
import {
  defaultSplitPanels,
  shotRangeAt,
  type ClipFramingTrack,
  type ClipperFramingValue,
} from "../../engine/render/framing-override.util";
import {
  createTextOverlay,
  cutSourceRange,
  framingShotBoundaries,
  getOutputDuration,
  setCaptionGroupText,
  setFramingAt,
  sourceToOutputTime,
  zoomSourceRange,
  type ClipEdit,
  type ClipTextPosition,
} from "../clip-edit.util";
import { DEFAULT_PAUSE_CUT_OPTIONS, isFillerWord, planPauseCuts } from "../auto-edit.util";

export type AiEditOperation =
  | { op: "remove_words"; from: number; to: number }
  | { op: "keep_only_words"; from: number; to: number }
  | { op: "remove_pauses" }
  | { op: "remove_fillers" }
  | { op: "add_text"; text: string; from_word: number; to_word: number; position?: ClipTextPosition }
  | { op: "edit_caption"; line: number; text: string }
  | { op: "set_captions_visible"; visible: boolean }
  | { op: "highlight_keywords" }
  | { op: "highlight_word"; line: number; word: string }
  | { op: "clear_highlights" }
  | { op: "punch_in"; from_word: number; to_word: number; zoom?: number }
  | { op: "set_volume"; value: number }
  | { op: "set_fades"; in?: number; out?: number }
  | { op: "set_framing"; shot: number; layout: "ai" | "one_shot" | "split_ai" | "split_manual" };

export interface AiEditPlan {
  summary: string;
  operations: AiEditOperation[];
}

export interface AiEditContext {
  duration: number;
  words: readonly WordCue[];
  /** Caption lines as currently rendered (edited or original). */
  captionGroups: readonly CaptionGroup[];
  aiShotBoundaries: readonly number[];
  /** False when the project's source video isn't loaded (captions/framing can't change). */
  canChangeSource: boolean;
}

export interface AiEditResult {
  edit: ClipEdit;
  applied: string[];
  skipped: string[];
}

// ---- Parsing --------------------------------------------------------------------------------

/** Extracts the JSON object from a model reply (tolerates code fences and stray prose). */
export function parseAiEditReply(reply: string): AiEditPlan {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return an edit plan. Try rephrasing.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("The AI's edit plan couldn't be read. Try again.");
  }
  const value = parsed as { summary?: unknown; operations?: unknown };
  const operations = Array.isArray(value.operations) ? value.operations.filter(isOperation) : [];
  return {
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
    operations,
  };
}

const OPS = new Set([
  "remove_words",
  "keep_only_words",
  "remove_pauses",
  "remove_fillers",
  "add_text",
  "edit_caption",
  "set_captions_visible",
  "highlight_keywords",
  "highlight_word",
  "clear_highlights",
  "punch_in",
  "set_volume",
  "set_fades",
  "set_framing",
]);

function isOperation(value: unknown): value is AiEditOperation {
  return Boolean(value) && typeof value === "object" && OPS.has((value as { op?: unknown }).op as string);
}

// ---- Applying -------------------------------------------------------------------------------

function isIndex(value: unknown, length: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Source-time span covered by words from..to, extended to the midpoints of the surrounding
 * gaps so a cut doesn't clip neighbouring words (and to the clip edges at either end).
 */
export function wordSpan(words: readonly WordCue[], from: number, to: number, duration: number): { start: number; end: number } {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const previous = words[a - 1];
  const next = words[b + 1];
  return {
    start: previous ? (previous.end + words[a]!.start) / 2 : 0,
    end: next ? (words[b]!.end + next.start) / 2 : duration,
  };
}

const FRAMING_DEFAULT: ClipperFramingValue = { mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false };

/**
 * Applies a plan in a fixed order (cuts first, then zooms, captions, text, audio, framing) so
 * word-based timings stay valid. Invalid operations are skipped and reported, never thrown.
 */
export function applyAiEditPlan(edit: ClipEdit, plan: AiEditPlan, context: AiEditContext): AiEditResult {
  const { words, duration } = context;
  const applied: string[] = [];
  const skipped: string[] = [];
  let next: ClipEdit = { ...edit };
  const order = (op: AiEditOperation["op"]) =>
    ["keep_only_words", "remove_words", "remove_pauses", "remove_fillers", "punch_in", "edit_caption", "clear_highlights", "highlight_keywords", "highlight_word", "set_captions_visible", "add_text", "set_volume", "set_fades", "set_framing"].indexOf(op);
  const operations = [...plan.operations].sort((a, b) => order(a.op) - order(b.op));
  const wordText = (from: number, to: number) => {
    const text = words.slice(Math.min(from, to), Math.max(from, to) + 1).map((w) => w.text).join(" ");
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  };

  for (const operation of operations) {
    switch (operation.op) {
      case "keep_only_words": {
        if (!isIndex(operation.from, words.length) || !isIndex(operation.to, words.length)) {
          skipped.push("A keep range referred to words that don't exist.");
          break;
        }
        const span = wordSpan(words, operation.from, operation.to, duration);
        next = cutSourceRange(cutSourceRange(next, span.end, duration), 0, span.start);
        applied.push(`Kept only “${wordText(operation.from, operation.to)}”`);
        break;
      }
      case "remove_words": {
        if (!isIndex(operation.from, words.length) || !isIndex(operation.to, words.length)) {
          skipped.push("A cut referred to words that don't exist.");
          break;
        }
        const span = wordSpan(words, operation.from, operation.to, duration);
        const before = next;
        next = cutSourceRange(next, span.start, span.end);
        if (next === before) skipped.push(`Couldn't cut “${wordText(operation.from, operation.to)}” (it would remove everything).`);
        else applied.push(`Cut “${wordText(operation.from, operation.to)}”`);
        break;
      }
      case "remove_pauses": {
        const plan = planPauseCuts(words, duration, { ...DEFAULT_PAUSE_CUT_OPTIONS, removeFillers: false });
        if (!plan) {
          skipped.push("There was no transcript to find pauses in.");
          break;
        }
        // Cut only what the plan drops, so earlier cuts are kept.
        let cursor = 0;
        for (const keep of plan.segments) {
          next = cutSourceRange(next, cursor, keep.start);
          cursor = keep.end;
        }
        next = cutSourceRange(next, cursor, duration);
        applied.push("Removed long pauses");
        break;
      }
      case "remove_fillers": {
        let count = 0;
        words.forEach((word, index) => {
          if (word.deleted || !isFillerWord(word.text)) return;
          const span = wordSpan(words, index, index, duration);
          // Never treat the clip edges as part of a filler: only cut the word itself.
          const start = index === 0 ? word.start : span.start;
          const end = index === words.length - 1 ? word.end : span.end;
          const before = next;
          next = cutSourceRange(next, start, end);
          if (next !== before) count++;
        });
        if (count) applied.push(`Removed ${count} filler word${count === 1 ? "" : "s"}`);
        else skipped.push("No filler words found.");
        break;
      }
      case "punch_in": {
        if (!isIndex(operation.from_word, words.length) || !isIndex(operation.to_word, words.length)) {
          skipped.push("A zoom referred to words that don't exist.");
          break;
        }
        const zoom = clamp(typeof operation.zoom === "number" ? operation.zoom : 1.15, 1.05, 1.5);
        const a = words[Math.min(operation.from_word, operation.to_word)]!;
        const b = words[Math.max(operation.from_word, operation.to_word)]!;
        next = zoomSourceRange(next, a.start, b.end, zoom);
        applied.push(`Zoomed to ${Math.round(zoom * 100)}% on “${wordText(operation.from_word, operation.to_word)}”`);
        break;
      }
      case "edit_caption": {
        if (!context.canChangeSource) {
          skipped.push("Caption changes need the project's source video.");
          break;
        }
        const groups = next.captionGroups ?? context.captionGroups;
        if (!isIndex(operation.line, groups.length) || typeof operation.text !== "string") {
          skipped.push("A caption edit referred to a line that doesn't exist.");
          break;
        }
        next = { ...next, captionGroups: setCaptionGroupText(groups, operation.line, operation.text) };
        applied.push(`Caption line ${operation.line + 1} → “${operation.text}”`);
        break;
      }
      case "highlight_keywords":
      case "highlight_word":
      case "clear_highlights": {
        if (!context.canChangeSource) {
          skipped.push("Highlighting caption words needs the project's source video.");
          break;
        }
        const groups = next.captionGroups ?? context.captionGroups;
        if (operation.op === "clear_highlights") {
          next = { ...next, captionGroups: clearKeywords(groups) };
          applied.push("Removed keyword highlights");
        } else if (operation.op === "highlight_keywords") {
          const highlighted = highlightKeywords(groups);
          next = { ...next, captionGroups: highlighted.groups };
          applied.push(`Highlighted ${highlighted.count} keyword${highlighted.count === 1 ? "" : "s"}`);
        } else {
          const group = isIndex(operation.line, groups.length) ? groups[operation.line]! : null;
          const target = String(operation.word ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
          const wordIndex = group
            ? group.words.findIndex((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === target)
            : -1;
          if (!group || wordIndex < 0) {
            skipped.push(`Couldn't find “${operation.word}” in caption line ${Number(operation.line) + 1}.`);
            break;
          }
          if (!group.words[wordIndex]!.emphasis) next = { ...next, captionGroups: toggleWordEmphasis(groups, operation.line, wordIndex) };
          applied.push(`Highlighted “${group.words[wordIndex]!.text}”`);
        }
        break;
      }
      case "set_captions_visible": {
        if (!context.canChangeSource) {
          skipped.push("Showing or hiding captions needs the project's source video.");
          break;
        }
        next = { ...next, captionsVisible: Boolean(operation.visible) };
        applied.push(operation.visible ? "Showed captions" : "Hid captions");
        break;
      }
      case "add_text": {
        if (!isIndex(operation.from_word, words.length) || !isIndex(operation.to_word, words.length) || !operation.text?.trim()) {
          skipped.push("A text overlay referred to words that don't exist.");
          break;
        }
        const total = getOutputDuration(next.segments);
        const start = sourceToOutputTime(next.segments, words[Math.min(operation.from_word, operation.to_word)]!.start);
        let end = sourceToOutputTime(next.segments, words[Math.max(operation.from_word, operation.to_word)]!.end);
        if (end - start < 0.8) end = Math.min(total, start + 2);
        const position: ClipTextPosition = operation.position === "middle" || operation.position === "bottom" ? operation.position : "top";
        next = {
          ...next,
          textOverlays: [...next.textOverlays, { ...createTextOverlay(start, total), text: operation.text.trim(), end, position }],
        };
        applied.push(`Added text “${operation.text.trim()}”`);
        break;
      }
      case "set_volume": {
        if (typeof operation.value !== "number" || !Number.isFinite(operation.value)) break;
        next = { ...next, volume: clamp(operation.value, 0, 2) };
        applied.push(`Volume ${Math.round(next.volume * 100)}%`);
        break;
      }
      case "set_fades": {
        const limit = getOutputDuration(next.segments) / 2;
        next = {
          ...next,
          fadeInSec: typeof operation.in === "number" ? clamp(operation.in, 0, Math.min(3, limit)) : next.fadeInSec,
          fadeOutSec: typeof operation.out === "number" ? clamp(operation.out, 0, Math.min(3, limit)) : next.fadeOutSec,
        };
        applied.push(`Fades ${next.fadeInSec.toFixed(1)}s in, ${next.fadeOutSec.toFixed(1)}s out`);
        break;
      }
      case "set_framing": {
        if (!context.canChangeSource || !next.framing) {
          skipped.push("Framing changes need the project's source video.");
          break;
        }
        const boundaries = framingShotBoundaries(next.framing, context.aiShotBoundaries);
        if (!isIndex(operation.shot, boundaries.length + 1)) {
          skipped.push("A framing change referred to a shot that doesn't exist.");
          break;
        }
        const shot = shotRangeAt(boundaries, operation.shot === 0 ? 0 : boundaries[operation.shot - 1]!, duration);
        const middle = (shot.start + shot.end) / 2;
        const track: ClipFramingTrack = next.framing;
        let value: ClipperFramingValue | null = null;
        if (operation.layout === "one_shot") value = { ...FRAMING_DEFAULT, singleShot: true };
        if (operation.layout === "split_ai") value = { ...FRAMING_DEFAULT, split: defaultSplitPanels(), splitFollow: true };
        if (operation.layout === "split_manual") value = { ...FRAMING_DEFAULT, split: defaultSplitPanels() };
        const cleared = { ...track, keyframes: track.keyframes.filter((k) => shotRangeAt(boundaries, k.t, duration).index !== shot.index) };
        next = { ...next, framing: value ? setFramingAt(cleared, boundaries, middle, value) : cleared };
        const label = { ai: "AI framing", one_shot: "one shot", split_ai: "AI-tracked split screen", split_manual: "split screen" }[operation.layout];
        applied.push(`Shot ${operation.shot + 1}: ${label ?? operation.layout}`);
        break;
      }
    }
  }
  return { edit: next, applied, skipped };
}
