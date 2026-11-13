/**
 * Hook reorder: a strong line from later in the clip plays first as a teaser ("…and that's how we
 * doubled revenue"), then the clip plays from the start. The hook is a source range rendered
 * before the edit's parts; text overlays keep their timing relative to the main edit.
 */
import type { WordCue } from "../lib/media/transcription-export.util";
import { keywordScore } from "./caption-keywords.util";
import type { AiChoice } from "./ai-editor/ai-choice.util";
import { requestEdit } from "./ai-editor/ai-editor-providers.util";
import { formatIndexedTranscript } from "./ai-editor/ai-editor-prompt.util";
import type { ClipEdit, ClipEditSegment } from "./clip-edit.util";

export interface ClipHook {
  /** Clip-local source range. */
  start: number;
  end: number;
  text: string;
}

const MIN_HOOK_SEC = 1.5;
const MAX_HOOK_SEC = 6.5;

/** The parts as rendered: the hook first, then the edit's parts. */
export function renderSegmentsFor(edit: Pick<ClipEdit, "segments" | "hook">): ClipEditSegment[] {
  const parts = edit.segments.filter((segment) => segment.end - segment.start > 0.001);
  if (!edit.hook || edit.hook.end - edit.hook.start < 0.3) return parts;
  return [{ id: "hook", start: edit.hook.start, end: edit.hook.end }, ...parts];
}

export function hookDuration(edit: Pick<ClipEdit, "hook">): number {
  return edit.hook ? Math.max(0, edit.hook.end - edit.hook.start) : 0;
}

interface Sentence {
  from: number;
  to: number;
  start: number;
  end: number;
  text: string;
}

/** Sentences from punctuation and long pauses. */
export function splitSentences(words: readonly WordCue[]): Sentence[] {
  const sentences: Sentence[] = [];
  let from = -1;
  words.forEach((word, index) => {
    if (word.deleted) return;
    if (from < 0) from = index;
    const next = words[index + 1];
    const endsSentence = /[.!?…]["')\]]*$/.test(word.text) || !next || next.start - word.end > 0.6;
    if (endsSentence) {
      const slice = words.slice(from, index + 1).filter((w) => !w.deleted);
      sentences.push({ from, to: index, start: words[from]!.start, end: word.end, text: slice.map((w) => w.text).join(" ") });
      from = -1;
    }
  });
  return sentences;
}

/**
 * Offline pick: a sentence from after the first fifth of the clip, 1.5-6.5 s long, with the most
 * stand-out words (numbers, names, strong words), a bonus for questions and exclamations.
 */
export function pickHookLocally(words: readonly WordCue[], duration: number): ClipHook | null {
  let best: { sentence: Sentence; score: number } | null = null;
  for (const sentence of splitSentences(words)) {
    const length = sentence.end - sentence.start;
    if (length < MIN_HOOK_SEC || length > MAX_HOOK_SEC || sentence.start < duration * 0.2) continue;
    const tokens = sentence.text.split(/\s+/);
    let score = tokens.reduce((sum, token, index) => sum + keywordScore(token, index === 0), 0) / Math.sqrt(tokens.length);
    if (/[!?]$/.test(sentence.text)) score += 3;
    if (/\d/.test(sentence.text)) score += 4;
    if (!best || score > best.score) best = { sentence, score };
  }
  return best ? { start: Math.max(0, best.sentence.start - 0.05), end: Math.min(duration, best.sentence.end + 0.1), text: best.sentence.text } : null;
}

const HOOK_SYSTEM = `You pick the hook for a short social video: one line from LATER in the clip that will play first as a teaser, so it must make a viewer want to keep watching (a surprising result, a bold claim, a question, a punchline). It must make sense on its own, be a complete phrase, and last about 1.5-6 seconds.
Reply with JSON only: {"from": n, "to": m, "why": "..."} using the [n] word numbers.`;

export async function pickHookWithAi(choice: AiChoice, words: readonly WordCue[], duration: number): Promise<ClipHook> {
  const reply = await requestEdit(choice.provider, choice.model, [
    { role: "system", content: HOOK_SYSTEM },
    { role: "user", content: `Clip length: ${duration.toFixed(1)}s\n\nTranscript:\n${formatIndexedTranscript(words)}` },
  ]);
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  const value = start >= 0 && end > start ? (JSON.parse(reply.slice(start, end + 1)) as { from?: unknown; to?: unknown }) : {};
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= words.length || to < from) {
    throw new Error("The AI didn't pick a usable hook.");
  }
  const hook = { start: Math.max(0, words[from]!.start - 0.05), end: Math.min(duration, words[to]!.end + 0.1) };
  if (hook.end - hook.start > MAX_HOOK_SEC * 1.5) throw new Error("The AI's hook was too long.");
  return { ...hook, text: words.slice(from, to + 1).map((w) => w.text).join(" ") };
}
