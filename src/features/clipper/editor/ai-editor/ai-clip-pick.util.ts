/**
 * In-app AI clip picking: the model reads the indexed transcript of the whole range and returns
 * word ranges for the best short clips. Results are stored exactly like MCP-picked AI clips.
 */
import type { WordCue } from "../../lib/media/transcription-export.util";
import type { ClipperClipPayload } from "../../persistence/clipper-clips-api.util";
import {
  estimateTokens,
  formatLines,
  requestJson,
  transcriptBudget,
  transcriptLines,
  type TranscriptLine,
} from "./ai-paper-edit.util";
import type { AiChoice } from "./ai-choice.util";

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
  /** The AI's 1-10 rating, when given. */
  score?: number;
}

const SYSTEM = `You are an editor picking the best short clips from a long video's transcript for TikTok, Reels and Shorts.
Good clips have a strong opening line (a hook), one clear idea or story, and end on a payoff; they make sense without the rest of the video.
The transcript comes as lines "[first-last] time text" (word numbers). Lines separated by "…" weren't next to each other.
Reply with JSON only, no prose:
{"clips":[{"title":"short hook title","reason":"why it works, one sentence","score":8,"segments":[{"from":n,"to":m}]}]}
- "from" is the first number of the line a clip starts on, "to" the last number of the line it ends on.
- "score" 1-10: how likely it is to do well on its own.
- Usually one segment per clip. Use 2-3 segments only to skip a tangent inside an otherwise great moment; keep them in order.
- Clips must not overlap each other.`;

const FORMAT_REMINDER = `Reply with the JSON only: {"clips":[{"title":"...","reason":"...","score":8,"segments":[{"from":n,"to":m}]}]}.`;

function pickRequest(
  text: string,
  count: number,
  options: ClipPickOptions,
  note = "",
): Array<{ role: "system" | "user"; content: string }> {
  const user = [
    `Pick up to ${count} clips, each ${options.minSec}-${options.maxSec} seconds long.${note}`,
    options.focus.trim() ? `Focus: ${options.focus.trim()}` : null,
    `Best clip first.`,
    `Transcript:\n${text}`,
    FORMAT_REMINDER,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: user },
  ];
}

export function buildClipPickMessages(
  words: readonly WordCue[],
  options: ClipPickOptions,
) {
  return pickRequest(
    formatLines(transcriptLines(words, [])),
    options.count,
    options,
  );
}

/** Validates the model's picks against the transcript and requested lengths. */
export function parseClipPicks(
  reply: string,
  words: readonly WordCue[],
  options: ClipPickOptions,
): { clips: PickedClip[]; rejected: number } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("The AI didn't return any clips. Try again.");
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
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n < words.length;

  for (const item of raw) {
    const value = item as {
      title?: unknown;
      reason?: unknown;
      segments?: unknown;
      score?: unknown;
    };
    const segments = (Array.isArray(value.segments) ? value.segments : [])
      .map((s) => s as { from?: unknown; to?: unknown })
      .filter(
        (s) =>
          valid(s.from) &&
          valid(s.to) &&
          (s.from as number) <= (s.to as number),
      )
      .map((s) => ({ from: s.from as number, to: s.to as number }))
      .sort((a, b) => a.from - b.from)
      .filter((s, i, list) => i === 0 || s.from > list[i - 1]!.to);
    const durationSec = segments.reduce(
      (sum, s) => sum + (words[s.to]!.end - words[s.from]!.start),
      0,
    );
    const overlaps = segments.some((s) =>
      used.some(([a, b]) => s.from <= b && s.to >= a),
    );
    // Allow some slack around the requested length; models count words, not seconds.
    if (
      segments.length === 0 ||
      overlaps ||
      durationSec < options.minSec * 0.6 ||
      durationSec > options.maxSec * 1.4
    ) {
      rejected++;
      continue;
    }
    segments.forEach((s) => used.push([s.from, s.to]));
    clips.push({
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim()
          : `Clip ${clips.length + 1}`,
      reason: typeof value.reason === "string" ? value.reason.trim() : "",
      segments,
      durationSec,
      score: typeof value.score === "number" ? value.score : undefined,
    });
    if (clips.length >= options.count) break;
  }
  return { clips, rejected };
}

/** Stored AI-clip records (same shape MCP's patch_ai_clips writes), numbered from `firstIndex`. */
export function clipPicksToPayload(
  clips: readonly PickedClip[],
  words: readonly WordCue[],
  firstIndex = 0,
): ClipperClipPayload[] {
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

/**
 * Picks clips from the whole video. A transcript that fits the model goes in one request; a
 * longer one is read in sections (candidates from each), then the candidates are ranked against
 * each other in one last request, so a two-hour video works with a local model too.
 */
export async function pickClipsWithAi(
  choice: AiChoice,
  words: readonly WordCue[],
  options: ClipPickOptions,
  run: { signal?: AbortSignal; onProgress?: (step: string) => void } = {},
): Promise<{ clips: PickedClip[]; rejected: number }> {
  if (words.length < 20)
    throw new Error("The transcript is too short to pick clips from.");
  const lines = transcriptLines(words, []);
  const budget = transcriptBudget(choice);
  const read = (count: number) => (value: unknown) => {
    const parsed = parseClipPicks(JSON.stringify(value), words, {
      ...options,
      count,
    });
    if (!parsed.clips.length && !parsed.rejected) throw new Error("no clips");
    return parsed;
  };
  if (estimateTokens(formatLines(lines)) <= budget) {
    run.onProgress?.("Reading the transcript");
    return requestJson(
      choice,
      pickRequest(formatLines(lines), options.count, options),
      run.signal,
      read(options.count),
      "any clips",
    );
  }

  // Sections that fit, each asked for a share of candidates (more than needed, to choose from).
  const sections: TranscriptLine[][] = [];
  let section: TranscriptLine[] = [];
  let size = 0;
  const limit = Math.round(budget * 0.8);
  for (const line of lines) {
    const tokens = estimateTokens(line.text) + 8;
    if (size + tokens > limit && section.length) {
      sections.push(section);
      section = [];
      size = 0;
    }
    section.push(line);
    size += tokens;
  }
  if (section.length) sections.push(section);
  const perSection = Math.max(
    2,
    Math.ceil((options.count * 2) / sections.length),
  );
  const candidates: PickedClip[] = [];
  let rejected = 0;
  for (const [index, part] of sections.entries()) {
    if (run.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    run.onProgress?.(`Reading part ${index + 1} of ${sections.length}`);
    const note = ` This is part ${index + 1} of ${sections.length} of the video; pick only from it.`;
    try {
      const found = await requestJson(
        choice,
        pickRequest(formatLines(part), perSection, options, note),
        run.signal,
        read(perSection),
        "any clips",
      );
      rejected += found.rejected;
      for (const clip of found.clips) {
        const overlaps = candidates.some((c) =>
          c.segments.some((a) =>
            clip.segments.some((b) => a.from <= b.to && a.to >= b.from),
          ),
        );
        if (!overlaps) candidates.push(clip);
      }
    } catch (error) {
      if (run.signal?.aborted) throw error;
      // One unreadable section doesn't sink the rest.
      rejected++;
    }
  }
  if (!candidates.length)
    throw new Error(
      "The AI didn't find clips that fit those lengths in any part of the video.",
    );
  if (candidates.length <= options.count)
    return { clips: candidates, rejected };

  // Rank all candidates against each other.
  run.onProgress?.(
    `Choosing the best ${options.count} of ${candidates.length}`,
  );
  const summary = candidates
    .map((clip, i) => {
      const text = words
        .slice(
          clip.segments[0]!.from,
          Math.min(clip.segments[0]!.to + 1, clip.segments[0]!.from + 40),
        )
        .map((w) => w.text)
        .join(" ");
      return `C${i + 1} (${Math.round(clip.durationSec)}s${clip.score ? `, rated ${clip.score}` : ""}): ${clip.title} — "${text}…"`;
    })
    .join("\n");
  const rankMessages: Array<{ role: "system" | "user"; content: string }> = [
    {
      role: "system",
      content: `You are an editor choosing which short clips to post. Rank by how well each would do on its own on TikTok, Reels and Shorts (hook, clarity, payoff)${options.focus.trim() ? `, with this focus: ${options.focus.trim()}` : ""}. Reply with JSON only: {"best": ["C3", "C1", ...]}.`,
    },
    {
      role: "user",
      content: `Pick the best ${options.count}, best first:\n${summary}\n\nReply with the JSON only: {"best": ["C..", ...]}.`,
    },
  ];
  try {
    const order = await requestJson(
      choice,
      rankMessages,
      run.signal,
      (value) => {
        const best = (value as { best?: unknown }).best;
        if (!Array.isArray(best)) throw new Error("no ranking");
        return best
          .map((id) => Number(String(id).replace(/\D/g, "")) - 1)
          .filter((i) => i >= 0 && i < candidates.length);
      },
      "a ranking",
    );
    const chosen = [...new Set(order)].map((i) => candidates[i]!);
    // Fill up from the AI's own ratings if the ranking was short.
    for (const clip of [...candidates].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    )) {
      if (chosen.length >= options.count) break;
      if (!chosen.includes(clip)) chosen.push(clip);
    }
    return { clips: chosen.slice(0, options.count), rejected };
  } catch (error) {
    if (run.signal?.aborted) throw error;
    return {
      clips: [...candidates]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, options.count),
      rejected,
    };
  }
}
