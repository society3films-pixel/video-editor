/**
 * Paper edit: the AI reads a whole interview and builds a long-form story from it: the best
 * answers in a narrative order, with performances (long stretches without talking) between
 * topics. The result is saved as one multi-part AI clip, rendered and edited like any other.
 */
import type { WordCue } from "../../lib/media/transcription-export.util";
import type { ClipperClipPayload } from "../../persistence/clipper-clips-api.util";
import type { AiChoice } from "./ai-choice.util";
import { requestEdit } from "./ai-editor-providers.util";

export interface PaperEditPart {
  title: string;
  startSec: number;
  endSec: number;
  wordStartIdx: number;
  wordEndIdx: number;
  kind: "talk" | "music";
}

export interface PaperEdit {
  title: string;
  parts: PaperEditPart[];
  durationSec: number;
}

/** Long stretches without words: usually songs or instrumental parts in a music interview. */
export function quietStretches(words: readonly WordCue[], minSec = 8): Array<{ id: string; start: number; end: number; before: number; after: number }> {
  const spoken = words.map((w, i) => ({ w, i })).filter(({ w }) => !w.deleted);
  const out: Array<{ id: string; start: number; end: number; before: number; after: number }> = [];
  for (let k = 1; k < spoken.length; k++) {
    const prev = spoken[k - 1]!;
    const next = spoken[k]!;
    if (next.w.start - prev.w.end >= minSec) out.push({ id: `M${out.length + 1}`, start: prev.w.end, end: next.w.start, before: prev.i, after: next.i });
  }
  return out;
}

function time(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Transcript in sentence-ish lines of [n]-numbered words, with quiet stretches marked. */
function transcriptForPaperEdit(words: readonly WordCue[], quiet: ReturnType<typeof quietStretches>): string {
  const lines: string[] = [];
  let line: string[] = [];
  let lineStart = 0;
  const marks = new Map(quiet.map((q) => [q.before, q]));
  words.forEach((word, index) => {
    if (word.deleted) return;
    if (!line.length) lineStart = word.start;
    line.push(`[${index}] ${word.text}`);
    const mark = marks.get(index);
    if (line.length >= 14 || /[.!?]$/.test(word.text) || mark) {
      lines.push(`${time(lineStart)}: ${line.join(" ")}`);
      line = [];
    }
    if (mark) lines.push(`${time(mark.start)}: ♪ ${mark.id}: ${Math.round(mark.end - mark.start)}s with no talking (likely music) ♪`);
  });
  if (line.length) lines.push(`${time(lineStart)}: ${line.join(" ")}`);
  return lines.join("\n");
}

const SYSTEM = `You are a documentary editor cutting a long-form video (YouTube) from a long interview with a musician. Build a story: pick the strongest, most revealing answers, and put them in an order that flows (origin → struggle → turning point → craft → now, or whatever the material suggests). You may reorder freely. Leave out interviewer questions, small talk, repetition and false starts.
Between topics, include performances: the ♪ M… ♪ marks are stretches without talking, usually music. Use them as breathers and to show what's being talked about.
Each talk part must be whole sentences (start at the first word of a sentence, end at the last word of one).
Reply with JSON only:
{"title": "...", "parts": [{"title": "short part title", "from": n, "to": m}, {"title": "...", "music": "M3"}, ...]}`;

export function buildPaperEditMessages(words: readonly WordCue[], targetMinutes: number, focus: string) {
  const quiet = quietStretches(words);
  return [
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content:
        `Target length: about ${targetMinutes} minutes.${focus.trim() ? ` Focus: ${focus.trim()}.` : ""}\n\n` +
        `Transcript:\n${transcriptForPaperEdit(words, quiet)}`,
    },
  ];
}

export function parsePaperEdit(reply: string, words: readonly WordCue[]): PaperEdit {
  const quiet = new Map(quietStretches(words).map((q) => [q.id, q]));
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return a paper edit.");
  const value = JSON.parse(reply.slice(start, end + 1)) as { title?: unknown; parts?: Array<Record<string, unknown>> };
  const parts: PaperEditPart[] = [];
  for (const raw of value.parts ?? []) {
    const title = String(raw.title ?? "").trim() || "Part";
    if (typeof raw.music === "string") {
      const q = quiet.get(raw.music);
      if (q) parts.push({ title, startSec: q.start, endSec: q.end, wordStartIdx: q.before, wordEndIdx: q.after, kind: "music" });
      continue;
    }
    const from = Number(raw.from);
    const to = Number(raw.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= words.length || to < from) continue;
    parts.push({ title, startSec: words[from]!.start, endSec: words[to]!.end, wordStartIdx: from, wordEndIdx: to, kind: "talk" });
  }
  // Drop overlaps with an earlier part (the same footage can't play twice).
  const used: Array<[number, number]> = [];
  const clean = parts.filter((p) => {
    if (used.some(([a, b]) => p.startSec < b && p.endSec > a)) return false;
    used.push([p.startSec, p.endSec]);
    return p.endSec - p.startSec >= 1;
  });
  if (!clean.length) throw new Error("The AI's paper edit had no usable parts.");
  return {
    title: String(value.title ?? "").trim() || "Long-form edit",
    parts: clean,
    durationSec: clean.reduce((sum, p) => sum + p.endSec - p.startSec, 0),
  };
}

export async function buildPaperEdit(choice: AiChoice, words: readonly WordCue[], targetMinutes: number, focus: string): Promise<PaperEdit> {
  if (words.length < 200) throw new Error("The transcript is too short for a long-form edit.");
  const reply = await requestEdit(choice.provider, choice.model, buildPaperEditMessages(words, targetMinutes, focus));
  return parsePaperEdit(reply, words);
}

/** The paper edit as one AI clip, its parts in story order. */
export function paperEditToClip(edit: PaperEdit, index: number): ClipperClipPayload {
  const segments = edit.parts.map((part, orderIndex) => ({
    orderIndex,
    startSec: part.startSec,
    endSec: part.endSec,
    wordStartIdx: part.wordStartIdx,
    wordEndIdx: part.wordEndIdx,
  }));
  return {
    index,
    startSec: Math.min(...segments.map((s) => s.startSec)),
    endSec: Math.max(...segments.map((s) => s.endSec)),
    label: `Long-form: ${edit.title}`,
    segments,
  };
}
