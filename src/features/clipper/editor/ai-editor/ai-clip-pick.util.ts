/**
 * In-app AI clip picking: the model reads the indexed transcript of the whole range and returns
 * word ranges for the best short clips. Results are stored exactly like MCP-picked AI clips.
 */
import type { WordCue } from "../../lib/media/transcription-export.util";
import type { ClipperClipPayload } from "../../persistence/clipper-clips-api.util";
import { formatIndexedTranscript } from "./ai-editor-prompt.util";
import type { AiChoice } from "./ai-choice.util";
import { requestEdit } from "./ai-editor-providers.util";

export interface ClipPickOptions {
  count: number;
  minSec: number;
  maxSec: number;
  /** Optional focus, e.g. "funny moments" or "anything about pricing". */
  focus: string;
}

export interface PickedClip {
  title: string;
  reason: string;
  segments: Array<{ from: number; to: number }>;
  durationSec: number;
}

const SYSTEM = `You are an editor picking the best short clips from a long video's transcript for TikTok, Reels and Shorts.
Good clips have a strong opening line (a hook), one clear idea or story, and end on a payoff; they make sense without the rest of the video.
Reply with JSON only, no prose:
{"clips":[{"title":"short hook title","reason":"why it works, one sentence","segments":[{"from":n,"to":m}]}]}
- from/to are the [n] word numbers in the transcript (inclusive).
- Usually one segment per clip. Use 2-3 segments only to skip a tangent inside an otherwise great moment; keep them in order.
- Start each clip on the first word of a sentence and end on the last word of a sentence.
- Clips must not overlap each other.`;

export function buildClipPickMessages(words: readonly WordCue[], options: ClipPickOptions) {
  const user = [
    `Pick up to ${options.count} clips, each ${options.minSec}-${options.maxSec} seconds long.`,
    options.focus.trim() ? `Focus: ${options.focus.trim()}` : null,
    `Best clip first.`,
    `Transcript (seconds: [word number] word):\n${formatIndexedTranscript(words)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: user },
  ];
}

/** Validates the model's picks against the transcript and requested lengths. */
export function parseClipPicks(reply: string, words: readonly WordCue[], options: ClipPickOptions): { clips: PickedClip[]; rejected: number } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return any clips. Try again.");
  let parsed: { clips?: unknown };
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("The AI's clip list couldn't be read. Try again.");
  }
  const raw = Array.isArray(parsed.clips) ? parsed.clips : [];
  const clips: PickedClip[] = [];
  const used: Array<[number, number]> = [];
  let rejected = 0;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < words.length;

  for (const item of raw) {
    const value = item as { title?: unknown; reason?: unknown; segments?: unknown };
    const segments = (Array.isArray(value.segments) ? value.segments : [])
      .map((s) => s as { from?: unknown; to?: unknown })
      .filter((s) => valid(s.from) && valid(s.to) && (s.from as number) <= (s.to as number))
      .map((s) => ({ from: s.from as number, to: s.to as number }))
      .sort((a, b) => a.from - b.from)
      .filter((s, i, list) => i === 0 || s.from > list[i - 1]!.to);
    const durationSec = segments.reduce((sum, s) => sum + (words[s.to]!.end - words[s.from]!.start), 0);
    const overlaps = segments.some((s) => used.some(([a, b]) => s.from <= b && s.to >= a));
    // Allow some slack around the requested length; models count words, not seconds.
    if (segments.length === 0 || overlaps || durationSec < options.minSec * 0.6 || durationSec > options.maxSec * 1.4) {
      rejected++;
      continue;
    }
    segments.forEach((s) => used.push([s.from, s.to]));
    clips.push({
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : `Clip ${clips.length + 1}`,
      reason: typeof value.reason === "string" ? value.reason.trim() : "",
      segments,
      durationSec,
    });
    if (clips.length >= options.count) break;
  }
  return { clips, rejected };
}

/** Stored AI-clip records (same shape MCP's patch_ai_clips writes), numbered from `firstIndex`. */
export function clipPicksToPayload(clips: readonly PickedClip[], words: readonly WordCue[], firstIndex = 0): ClipperClipPayload[] {
  return clips.map((clip, offset) => {
    const segments = clip.segments.map((s, orderIndex) => ({
      orderIndex,
      startSec: words[s.from]!.start,
      endSec: words[s.to]!.end,
      wordStartIdx: s.from,
      wordEndIdx: s.to,
    }));
    return {
      index: firstIndex + offset,
      startSec: segments[0]!.startSec,
      endSec: segments[segments.length - 1]!.endSec,
      label: clip.title,
      segments,
    };
  });
}

export async function pickClipsWithAi(
  choice: AiChoice,
  words: readonly WordCue[],
  options: ClipPickOptions,
): Promise<{ clips: PickedClip[]; rejected: number }> {
  if (words.length < 20) throw new Error("The transcript is too short to pick clips from.");
  const reply = await requestEdit(choice.provider, choice.model, buildClipPickMessages(words, options));
  return parseClipPicks(reply, words, options);
}
