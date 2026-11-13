/**
 * "Who's talking" for an AI-tracked split screen. The app has no speaker labels, so this looks
 * at mouth movement: for each sampled frame, how much the lower part of each tracked face changed
 * since the previous sample. While a word is being spoken, the person whose mouth moves more
 * (relative to their own usual movement) is the speaker. The result is a list of spans in
 * clip-local time; the renderer grows that person's panel.
 */
import type { WordCue } from "../../lib/media/transcription-export.util";

/** Who is talking from `start` to `end` (clip-local seconds). 0 = left person, 1 = right person. */
export interface SpeakerSpan {
  start: number;
  end: number;
  person: 0 | 1;
}

/** Mouth movement of the left and right person at a clip-local time (arbitrary units). */
export interface MouthActivitySample {
  t: number;
  left: number;
  right: number;
}

/** Extra share of the frame the talking person's panel gets (0.12 = 62/38). */
export const SPEAKER_EMPHASIS_SHARE = 0.12;
/** Length of the grow/shrink animation when the speaker changes. */
const RAMP_SEC = 0.35;
/** A word's movement must beat the other person's by this ratio to count. */
const DECISION_RATIO = 1.15;
/** A speaker turn shorter than this is merged into its neighbours (no flicker on "yeah"). */
const MIN_TURN_SEC = 0.9;

/** Low percentile: roughly how much a person's mouth area moves while they're listening. */
function restingLevel(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.1)]!;
}

export function speakerSpansFromActivity(
  samples: readonly MouthActivitySample[],
  words: readonly WordCue[],
  duration: number,
): SpeakerSpan[] {
  if (samples.length < 4) return [];
  // Compare against each person's resting movement, so a sharper camera angle or a fidgety
  // listener doesn't always win. Capped, so someone who talks the whole clip still counts.
  const restingRatio = Math.min(2, Math.max(0.5, restingLevel(samples.map((s) => s.left)) / Math.max(1e-6, restingLevel(samples.map((s) => s.right)))));
  const leftBase = restingRatio;
  const rightBase = 1;

  type Turn = { start: number; end: number; person: 0 | 1 };
  const decided: Turn[] = [];
  for (const word of words) {
    if (word.deleted || !(word.end > word.start)) continue;
    const inside = samples.filter((s) => s.t >= word.start - 0.1 && s.t <= word.end + 0.1);
    if (!inside.length) continue;
    const left = inside.reduce((sum, s) => sum + s.left, 0) / inside.length / leftBase;
    const right = inside.reduce((sum, s) => sum + s.right, 0) / inside.length / rightBase;
    if (left > right * DECISION_RATIO) decided.push({ start: word.start, end: word.end, person: 0 });
    else if (right > left * DECISION_RATIO) decided.push({ start: word.start, end: word.end, person: 1 });
  }
  if (!decided.length) return [];

  // Group words into turns.
  let turns: Turn[] = [];
  for (const word of decided) {
    const last = turns[turns.length - 1];
    if (last && last.person === word.person) last.end = word.end;
    else turns.push({ ...word });
  }
  // Merge short turns into the neighbour they interrupt, shortest first, until all are long enough.
  for (;;) {
    let shortest = -1;
    for (let i = 0; i < turns.length; i++) {
      const length = turns[i]!.end - turns[i]!.start;
      if (turns.length > 1 && length < MIN_TURN_SEC && (shortest < 0 || length < turns[shortest]!.end - turns[shortest]!.start)) shortest = i;
    }
    if (shortest < 0) break;
    const turn = turns[shortest]!;
    const prev = turns[shortest - 1];
    const next = turns[shortest + 1];
    const into = !prev ? next! : !next ? prev : prev.end - prev.start >= next.end - next.start ? prev : next;
    into.start = Math.min(into.start, turn.start);
    into.end = Math.max(into.end, turn.end);
    turns.splice(shortest, 1);
    const merged: Turn[] = [];
    for (const t of turns) {
      const last = merged[merged.length - 1];
      if (last && last.person === t.person) last.end = Math.max(last.end, t.end);
      else merged.push(t);
    }
    turns = merged;
  }
  // Fill the gaps: switch halfway between turns, hold the first and last speaker to the edges.
  return turns.map((turn, i) => ({
    person: turn.person,
    start: i === 0 ? 0 : (turns[i - 1]!.end + turn.start) / 2,
    end: i === turns.length - 1 ? Math.max(duration, turn.end) : (turn.end + turns[i + 1]!.start) / 2,
  }));
}

/** +1 while the left person talks, -1 for the right person, 0 with no speaker spans. */
function rawSpeakerAt(spans: readonly SpeakerSpan[], t: number): number {
  if (!spans.length) return 0;
  if (t < spans[0]!.start) return spans[0]!.person === 0 ? 1 : -1;
  for (const span of spans) if (t < span.end) return span.person === 0 ? 1 : -1;
  return spans[spans.length - 1]!.person === 0 ? 1 : -1;
}

/** Speaker value at `t` with a short ramp at each change (-1..1, positive = left person). */
export function speakerEmphasisAt(spans: readonly SpeakerSpan[] | undefined, t: number): number {
  if (!spans?.length) return 0;
  const steps = 8;
  let sum = 0;
  for (let i = 0; i <= steps; i++) sum += rawSpeakerAt(spans, t - RAMP_SEC / 2 + (RAMP_SEC * i) / steps);
  const linear = sum / (steps + 1);
  // Ease the ramp.
  const u = (linear + 1) / 2;
  return u * u * (3 - 2 * u) * 2 - 1;
}

/** Share (0..1) of the frame for the first panel, given the speaker value and whether people are swapped. */
export function firstPanelShare(emphasis: number, swapped: boolean): number {
  return 0.5 + SPEAKER_EMPHASIS_SHARE * (swapped ? -emphasis : emphasis);
}
