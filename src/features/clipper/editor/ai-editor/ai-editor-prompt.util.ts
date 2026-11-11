import type { CaptionGroup, WordCue } from "../../lib/media/transcription-export.util";
import { getOutputDuration, type ClipEdit } from "../clip-edit.util";

export interface AiPromptContext {
  duration: number;
  words: readonly WordCue[];
  captionGroups: readonly CaptionGroup[];
  /** Shot boundaries in clip-local seconds. */
  shotBoundaries: readonly number[];
  canChangeSource: boolean;
  title?: string;
}

const SYSTEM_PROMPT = `You are a video editor for short social clips (TikTok, Reels, Shorts). The user gives an instruction; you reply with an edit plan as JSON only, no prose.

Reply format:
{"summary": "<one or two sentences on what you changed and why>", "operations": [ ... ]}

Operations (word numbers are the [n] indexes in the transcript; ranges are inclusive):
- {"op":"remove_words","from":n,"to":m}            cut these words (and the silence around them)
- {"op":"keep_only_words","from":n,"to":m}         trim the clip to just this range
- {"op":"remove_pauses"}                           shorten long silences
- {"op":"remove_fillers"}                          cut um/uh-type filler words
- {"op":"add_text","text":"...","from_word":n,"to_word":m,"position":"top|middle|bottom"}   on-screen text while those words play
- {"op":"edit_caption","line":k,"text":"..."}      rewrite caption line k (keep the meaning; fix wording or spelling)
- {"op":"set_captions_visible","visible":true|false}
- {"op":"highlight_keywords"}                      colour one key word in caption lines automatically
- {"op":"highlight_word","line":k,"word":"..."}    colour this word of caption line k (keyword emphasis)
- {"op":"clear_highlights"}                        remove all keyword colouring
- {"op":"punch_in","from_word":n,"to_word":m,"zoom":1.05-1.5}  zoom in for emphasis
- {"op":"set_volume","value":0-2}                  1 = unchanged
- {"op":"set_fades","in":seconds,"out":seconds}
- {"op":"set_framing","shot":s,"layout":"ai|one_shot|split_ai|split_manual"}   split_ai = split screen where the AI follows each person

Rules:
- Only use word, line and shot numbers that appear below.
- Cut whole thoughts; don't leave a sentence half-finished unless asked.
- Operations act on the clip as it is now (existing cuts are listed); add to them rather than redoing them.
- Prefer a few precise operations. If the instruction can't be done with these operations, return no operations and explain in the summary.
- Keep on-screen text short (under about 8 words).`;

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

/** The transcript as caption-sized lines of indexed words: "[12] word". */
export function formatIndexedTranscript(words: readonly WordCue[]): string {
  const lines: string[] = [];
  let line: string[] = [];
  let lineStart = 0;
  words.forEach((word, index) => {
    if (word.deleted) return;
    if (line.length === 0) lineStart = word.start;
    line.push(`[${index}] ${word.text}`);
    if (line.length >= 12 || /[.!?]$/.test(word.text)) {
      lines.push(`${formatSeconds(lineStart)}: ${line.join(" ")}`);
      line = [];
    }
  });
  if (line.length) lines.push(`${formatSeconds(lineStart)}: ${line.join(" ")}`);
  return lines.join("\n");
}

export function buildAiEditMessages(
  instruction: string,
  edit: ClipEdit,
  context: AiPromptContext,
): Array<{ role: "system" | "user"; content: string }> {
  const kept = edit.segments.map((s) => `${formatSeconds(s.start)}-${formatSeconds(s.end)}${s.zoom && s.zoom > 1 ? ` (zoom ${Math.round(s.zoom * 100)}%)` : ""}`);
  const shots = [0, ...context.shotBoundaries].map((start, index, all) => {
    const end = all[index + 1] ?? context.duration;
    return `${index}: ${formatSeconds(start)}-${formatSeconds(end)}`;
  });
  const captions = (edit.captionGroups ?? context.captionGroups).map(
    (group, index) => `${index}: ${group.words.map((w) => (w.emphasis ? `*${w.text}*` : w.text)).join(" ")}`,
  );

  const sections = [
    context.title ? `Clip title: ${context.title}` : null,
    `Clip length: ${formatSeconds(context.duration)}; after current cuts: ${formatSeconds(getOutputDuration(edit.segments))}.`,
    `Currently kept parts: ${kept.join(", ")}`,
    edit.textOverlays.length ? `Existing on-screen text: ${edit.textOverlays.map((t) => `“${t.text}”`).join(", ")}` : null,
    `Volume: ${Math.round(edit.volume * 100)}%. Fades: ${edit.fadeInSec.toFixed(1)}s in, ${edit.fadeOutSec.toFixed(1)}s out.`,
    context.canChangeSource
      ? `Shots:\n${shots.join("\n")}\n\nCaption lines (*word* = highlighted keyword):\n${captions.join("\n") || "(none)"}`
      : "Captions and framing can't be changed for this clip (don't use edit_caption, set_captions_visible, highlight_keywords, highlight_word, clear_highlights or set_framing).",
    `Transcript:\n${formatIndexedTranscript(context.words) || "(no transcript; word operations are not available)"}`,
    `Instruction: ${instruction.trim()}`,
  ].filter(Boolean);

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: sections.join("\n\n") },
  ];
}
