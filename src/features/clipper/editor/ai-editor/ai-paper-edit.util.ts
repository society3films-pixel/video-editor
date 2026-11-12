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
  kind: "talk" | "music" | "performance";
  /** For "performance": the id of a separately recorded performance (see PaperEditExtra). */
  performanceId?: string;
}

/** A performance recorded as its own file (not in the main recording), offered to the AI by id. */
export interface PaperEditExtra {
  id: string;
  label: string;
  durationSec: number;
}

export interface PaperEdit {
  title: string;
  parts: PaperEditPart[];
  durationSec: number;
}

/** Long stretches without words: usually songs or instrumental parts in a music interview. */
export function quietStretches(
  words: readonly WordCue[],
  minSec = 8,
): Array<{
  id: string;
  start: number;
  end: number;
  before: number;
  after: number;
}> {
  const spoken = words.map((w, i) => ({ w, i })).filter(({ w }) => !w.deleted);
  const out: Array<{
    id: string;
    start: number;
    end: number;
    before: number;
    after: number;
  }> = [];
  for (let k = 1; k < spoken.length; k++) {
    const prev = spoken[k - 1]!;
    const next = spoken[k]!;
    if (next.w.start - prev.w.end >= minSec)
      out.push({
        id: `M${out.length + 1}`,
        start: prev.w.end,
        end: next.w.start,
        before: prev.i,
        after: next.i,
      });
  }
  return out;
}

function time(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const SYSTEM = `You are a documentary editor cutting a long-form video (YouTube) from a long interview with a musician. Build a story: pick the strongest, most revealing answers, and put them in an order that flows (origin → struggle → turning point → craft → now, or whatever the material suggests). You may reorder freely. Leave out interviewer questions, small talk, repetition and false starts.
Between topics, include performances: the ♪ M… ♪ marks are stretches without talking, usually music. Use them as breathers and to show what's being talked about.
Each talk part must be whole sentences (start at the first word of a sentence, end at the last word of one).
The transcript comes as lines "[first-last] time text": "from" is the first number of the line a part starts on, "to" the last number of the line it ends on. Lines separated by "…" weren't next to each other in the interview.
Reply with JSON only:
{"title": "...", "parts": [{"title": "short part title", "from": n, "to": m}, {"title": "...", "music": "M3"}, ...]}`;

interface TranscriptLine {
  from: number;
  to: number;
  start: number;
  text: string;
  /** A quiet stretch (likely music) right after this line. */
  quiet?: ReturnType<typeof quietStretches>[number];
}

/** The transcript as sentence lines, each with the index range of its words. */
function transcriptLines(
  words: readonly WordCue[],
  quiet: ReturnType<typeof quietStretches>,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const marks = new Map(quiet.map((q) => [q.before, q]));
  let current: { from: number; start: number; texts: string[] } | null = null;
  words.forEach((word, index) => {
    if (word.deleted) return;
    current ??= { from: index, start: word.start, texts: [] };
    current.texts.push(word.text);
    const mark = marks.get(index);
    if (current.texts.length >= 40 || /[.!?]["”']?$/.test(word.text) || mark) {
      lines.push({
        from: current.from,
        to: index,
        start: current.start,
        text: current.texts.join(" "),
        quiet: mark,
      });
      current = null;
    }
  });
  const last = current as {
    from: number;
    start: number;
    texts: string[];
  } | null;
  if (last)
    lines.push({
      from: last.from,
      to: words.length - 1,
      start: last.start,
      text: last.texts.join(" "),
    });
  return lines;
}

function formatLines(lines: readonly TranscriptLine[]): string {
  const out: string[] = [];
  let previous: TranscriptLine | null = null;
  for (const line of lines) {
    if (previous && line.from > previous.to + 1 && !previous.quiet)
      out.push("…");
    out.push(`[${line.from}-${line.to}] ${time(line.start)} ${line.text}`);
    if (line.quiet)
      out.push(
        `♪ ${line.quiet.id}: ${Math.round(line.quiet.end - line.quiet.start)}s with no talking (likely music) ♪`,
      );
    previous = line;
  }
  return out.join("\n");
}

/** Rough token count (about 4 characters a token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

const FORMAT_REMINDER = `Reply with the JSON only, no other text: {"title": "...", "parts": [{"title": "...", "from": n, "to": m}, {"title": "...", "music": "M3"}, ...]}. "from" is the first number of a line's [from-to] range, "to" the last number of a (later or same) line's range.`;

export function buildPaperEditMessages(
  words: readonly WordCue[],
  targetMinutes: number,
  focus: string,
  extras: readonly PaperEditExtra[] = [],
  lines?: readonly TranscriptLine[],
) {
  const quiet = quietStretches(words);
  const extraText = extras.length
    ? `\n\nSeparately recorded performances you can place too, as {"title": "...", "performance": "P1"}:\n` +
      extras
        .map((e) => `${e.id}: ${e.label} (${time(e.durationSec)})`)
        .join("\n")
    : "";
  return [
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content:
        `Target length: about ${targetMinutes} minutes.${focus.trim() ? ` Focus: ${focus.trim()}.` : ""}\n\n` +
        `Transcript (each line: [first-last word number] time text):\n${formatLines(lines ?? transcriptLines(words, quiet))}${extraText}\n\n` +
        FORMAT_REMINDER,
    },
  ];
}

const SHORTLIST_SYSTEM = `You are a documentary editor going through one section of a long interview with a musician. Mark the passages worth considering for the final film: revealing, emotional, funny or specific stories and strong statements, in whole sentences. Skip interviewer questions, small talk, repetition and false starts.
Reply with JSON only: {"keep": [[from, to], ...]} using the [from-to] numbers of the lines (a passage can span several lines).`;

/**
 * For transcripts too long for the model in one go: each section is shortlisted first, and the
 * story is then built from the kept lines (plus the music marks).
 */
async function shortlistLines(
  choice: AiChoice,
  lines: readonly TranscriptLine[],
  budget: number,
  share: number,
  focus: string,
  signal?: AbortSignal,
): Promise<TranscriptLine[]> {
  const chunks: TranscriptLine[][] = [];
  let chunk: TranscriptLine[] = [];
  let size = 0;
  for (const line of lines) {
    const tokens = estimateTokens(line.text) + 8;
    if (size + tokens > budget && chunk.length) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += tokens;
  }
  if (chunk.length) chunks.push(chunk);
  const kept: TranscriptLine[] = [];
  for (const section of chunks) {
    const messages = [
      { role: "system" as const, content: SHORTLIST_SYSTEM },
      {
        role: "user" as const,
        content:
          `Keep roughly ${Math.max(10, Math.round(share * 100))}% of this section.${focus.trim() ? ` The film's focus: ${focus.trim()}.` : ""}\n\n${formatLines(section)}\n\n` +
          `Reply with the JSON only: {"keep": [[from, to], ...]}.`,
      },
    ];
    const ranges = await requestJson(choice, messages, signal, (value) => {
      const keep = (value as { keep?: unknown }).keep;
      if (!Array.isArray(keep)) throw new Error("no keep list");
      return keep
        .filter((r): r is [number, number] => Array.isArray(r) && r.length >= 2)
        .map((r) => [Number(r[0]), Number(r[1])] as [number, number]);
    });
    for (const line of section) {
      if (line.quiet || ranges.some(([a, b]) => line.to >= a && line.from <= b))
        kept.push(line);
    }
  }
  return kept;
}

/** Parses the reply's JSON; asks once more (stricter) when the model answered with something else. */
async function requestJson<T>(
  choice: AiChoice,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal | undefined,
  read: (value: unknown) => T,
): Promise<T> {
  let reply = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const asked =
      attempt === 0
        ? messages
        : [
            ...messages.slice(0, -1),
            {
              ...messages[messages.length - 1]!,
              content: `${messages[messages.length - 1]!.content}\n\nIMPORTANT: answer with a single JSON object and nothing else.`,
            },
          ];
    reply = await requestEdit(choice.provider, choice.model, asked, signal);
    try {
      return read(extractJson(reply));
    } catch {
      // Try again.
    }
  }
  const sample = reply.replace(/\s+/g, " ").trim().slice(0, 160);
  throw new Error(
    `The AI didn't return a paper edit${sample ? ` (it replied: "${sample}${reply.length > 160 ? "…" : ""}")` : " (empty reply)"}. ` +
      "With a local model, a bigger model (or a larger context in Ollama) helps.",
  );
}

function extractJson(reply: string): unknown {
  const cleaned = reply
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** How much transcript (tokens) to send in one request: local models have smaller contexts. */
function transcriptBudget(choice: AiChoice): number {
  return choice.provider === "local"
    ? 18000
    : choice.provider === "anthropic"
      ? 150000
      : 60000;
}

export function parsePaperEdit(
  reply: string,
  words: readonly WordCue[],
  extras: readonly PaperEditExtra[] = [],
): PaperEdit {
  const extraById = new Map(extras.map((e) => [e.id, e]));
  const quiet = new Map(quietStretches(words).map((q) => [q.id, q]));
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("The AI didn't return a paper edit.");
  const value = JSON.parse(reply.slice(start, end + 1)) as {
    title?: unknown;
    parts?: Array<Record<string, unknown>>;
  };
  const parts: PaperEditPart[] = [];
  for (const raw of value.parts ?? []) {
    const title = String(raw.title ?? "").trim() || "Part";
    if (typeof raw.performance === "string") {
      const extra = extraById.get(raw.performance);
      if (extra && !parts.some((p) => p.performanceId === extra.id)) {
        parts.push({
          title,
          startSec: 0,
          endSec: extra.durationSec,
          wordStartIdx: -1,
          wordEndIdx: -1,
          kind: "performance",
          performanceId: extra.id,
        });
      }
      continue;
    }
    if (typeof raw.music === "string") {
      const q = quiet.get(raw.music);
      if (q)
        parts.push({
          title,
          startSec: q.start,
          endSec: q.end,
          wordStartIdx: q.before,
          wordEndIdx: q.after,
          kind: "music",
        });
      continue;
    }
    const from = Number(raw.from);
    const to = Number(raw.to);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to >= words.length ||
      to < from
    )
      continue;
    parts.push({
      title,
      startSec: words[from]!.start,
      endSec: words[to]!.end,
      wordStartIdx: from,
      wordEndIdx: to,
      kind: "talk",
    });
  }
  // Drop overlaps with an earlier part (the same footage can't play twice).
  const used: Array<[number, number]> = [];
  const clean = parts.filter((p) => {
    if (p.kind === "performance") return true;
    if (used.some(([a, b]) => p.startSec < b && p.endSec > a)) return false;
    used.push([p.startSec, p.endSec]);
    return p.endSec - p.startSec >= 1;
  });
  if (!clean.length)
    throw new Error("The AI's paper edit had no usable parts.");
  return {
    title: String(value.title ?? "").trim() || "Long-form edit",
    parts: clean,
    durationSec: clean.reduce((sum, p) => sum + p.endSec - p.startSec, 0),
  };
}

export async function buildPaperEdit(
  choice: AiChoice,
  words: readonly WordCue[],
  targetMinutes: number,
  focus: string,
  extras: readonly PaperEditExtra[] = [],
  options: { signal?: AbortSignal; onProgress?: (step: string) => void } = {},
): Promise<PaperEdit> {
  if (words.length < 200)
    throw new Error("The transcript is too short for a long-form edit.");
  let lines = transcriptLines(words, quietStretches(words));
  const budget = transcriptBudget(choice);
  const total = estimateTokens(formatLines(lines));
  if (total > budget) {
    options.onProgress?.("Shortlisting the best passages");
    const spokenMinutes = (words[words.length - 1]!.end - words[0]!.start) / 60;
    // Keep about three times the target, so the story still has choices.
    const share = Math.min(
      0.6,
      Math.max(0.15, (targetMinutes * 3) / Math.max(1, spokenMinutes)),
    );
    lines = await shortlistLines(
      choice,
      lines,
      Math.round(budget * 0.8),
      share,
      focus,
      options.signal,
    );
    // Still too long: keep tightening.
    while (estimateTokens(formatLines(lines)) > budget && lines.length > 50) {
      lines = await shortlistLines(
        choice,
        lines,
        Math.round(budget * 0.8),
        0.5,
        focus,
        options.signal,
      );
    }
  }
  options.onProgress?.("Building the story");
  const messages = buildPaperEditMessages(
    words,
    targetMinutes,
    focus,
    extras,
    lines,
  );
  return requestJson(choice, messages, options.signal, (value) =>
    parsePaperEdit(JSON.stringify(value), words, extras),
  );
}

/** The paper edit as one AI clip, its parts in story order. */
export function paperEditToClip(
  edit: PaperEdit,
  index: number,
): ClipperClipPayload {
  const segments = edit.parts
    .filter((part) => part.kind !== "performance")
    .map((part, orderIndex) => ({
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
