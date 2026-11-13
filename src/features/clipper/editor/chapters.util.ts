/**
 * Chapters: topic changes found by the AI. Inside a clip they become short title cards; across a
 * whole long video they become YouTube chapters (timestamps for the description).
 */
import type { WordCue } from "../lib/media/transcription-export.util";
import type { AiChoice } from "./ai-editor/ai-choice.util";
import { requestEdit } from "./ai-editor/ai-editor-providers.util";
import { formatIndexedTranscript } from "./ai-editor/ai-editor-prompt.util";
import { createEditId, getOutputDuration, sourceToOutputTime, type ClipEdit, type ClipTextOverlay } from "./clip-edit.util";

export interface Chapter {
  /** Word index where the chapter starts. */
  word: number;
  title: string;
}

function parseChapters(reply: string, wordCount: number): Chapter[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return chapters.");
  const value = JSON.parse(reply.slice(start, end + 1)) as { chapters?: Array<{ word?: unknown; title?: unknown }> };
  const chapters = (value.chapters ?? [])
    .map((c) => ({ word: Number(c.word), title: String(c.title ?? "").trim() }))
    .filter((c) => Number.isInteger(c.word) && c.word >= 0 && c.word < wordCount && c.title)
    .sort((a, b) => a.word - b.word);
  return chapters.filter((c, i) => i === 0 || c.word > chapters[i - 1]!.word);
}

const CARD_SYSTEM = `You add chapter title cards to a short social video. Find where the topic or step changes (e.g. "Step 1: ...", "The mistake", "The fix") and give each a title of 1-4 words.
Use 2-5 cards for the clip, never one in the first 2 seconds, and only where a new part really starts.
Reply with JSON only: {"chapters":[{"word": n, "title": "..."}]} using the [n] word numbers where each part starts.`;

/** Asks the AI for title cards and adds them as text overlays (replacing earlier chapter cards). */
export async function addChapterCards(choice: AiChoice, edit: ClipEdit, words: readonly WordCue[]): Promise<{ edit: ClipEdit; count: number }> {
  const reply = await requestEdit(choice.provider, choice.model, [
    { role: "system", content: CARD_SYSTEM },
    { role: "user", content: `Transcript:\n${formatIndexedTranscript(words)}` },
  ]);
  const chapters = parseChapters(reply, words.length);
  const outputDuration = getOutputDuration(edit.segments);
  const kept = (t: number) => edit.segments.some((s) => t >= s.start && t < s.end);
  const cards: ClipTextOverlay[] = [];
  for (const chapter of chapters) {
    const sourceTime = words[chapter.word]!.start;
    if (!kept(sourceTime)) continue;
    const start = sourceToOutputTime(edit.segments, sourceTime);
    if (start < 1.5 || start > outputDuration - 1) continue;
    cards.push({
      id: createEditId("chapter"),
      text: chapter.title,
      start,
      end: Math.min(outputDuration, start + 1.6),
      position: "middle",
      size: 0.07,
      color: "#FFFFFF",
      background: true,
    });
  }
  return {
    edit: { ...edit, textOverlays: [...edit.textOverlays.filter((o) => !o.id.startsWith("chapter-")), ...cards] },
    count: cards.length,
  };
}

const YOUTUBE_SYSTEM = `You write YouTube chapters for a long video from its transcript. Split it into 4-15 chapters where the topic changes, each with a clear 2-6 word title. The first chapter must start at word 0. Chapters should be at least 30 seconds apart.
Reply with JSON only: {"chapters":[{"word": n, "title": "..."}]} using the [n] word numbers where each chapter starts.`;

function timestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** YouTube chapter lines ("0:00 Intro") for a long video's transcript. `offsetSec` = where the words' clock starts in the full video. */
export async function writeYoutubeChapters(choice: AiChoice, words: readonly WordCue[], offsetSec = 0): Promise<string> {
  const reply = await requestEdit(choice.provider, choice.model, [
    { role: "system", content: YOUTUBE_SYSTEM },
    { role: "user", content: `Transcript:\n${formatIndexedTranscript(words)}` },
  ]);
  const chapters = parseChapters(reply, words.length);
  if (!chapters.length) throw new Error("The AI didn't find chapters.");
  if (chapters[0]!.word !== 0) chapters.unshift({ word: 0, title: "Intro" });
  const lines: string[] = [];
  let last = -Infinity;
  for (const chapter of chapters) {
    const t = offsetSec + words[chapter.word]!.start;
    if (t - last < 10) continue;
    lines.push(`${timestamp(lines.length === 0 ? 0 : t)} ${chapter.title}`);
    last = t;
  }
  return lines.join("\n");
}
