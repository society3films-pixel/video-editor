/**
 * Short clips from the performances in a long recording: the strongest 20-40 s of each song
 * (loudest stretch, ends snapped to quieter moments so they land between phrases), ranked by how
 * loud the crowd is right after the song, plus "talk then play" clips where the musician
 * explains something just before playing it.
 */
import type { WordCue } from "../lib/media/transcription-export.util";
import type { ClipperClipPayload } from "../persistence/clipper-clips-api.util";
import { frameLevels, musicSectionsFromLevels } from "./music-detect.util";

export interface PerformanceMoment {
  kind: "highlight" | "talk-then-play";
  start: number;
  end: number;
  score: number;
  title: string;
}

const FRAME = 0.02;

function secondLevels(levels: Float32Array): Float32Array {
  const per = Math.round(1 / FRAME);
  const out = new Float32Array(Math.floor(levels.length / per));
  for (let s = 0; s < out.length; s++) {
    let sum = 0;
    for (let i = 0; i < per; i++) sum += levels[s * per + i]! ** 2;
    out[s] = Math.sqrt(sum / per);
  }
  return out;
}

/** The quietest second within ±2 s of `t` (a phrase boundary, roughly). */
function snapToDip(seconds: Float32Array, t: number, lo: number, hi: number): number {
  let best = t;
  let bestLevel = Infinity;
  for (let s = Math.max(lo, t - 2); s <= Math.min(hi, t + 2); s++) {
    const level = seconds[Math.round(s)] ?? Infinity;
    if (level < bestLevel) {
      bestLevel = level;
      best = s;
    }
  }
  return best;
}

export function findPerformanceMoments(
  levels: Float32Array,
  words: readonly WordCue[],
  options: { minSec?: number; maxSec?: number; count?: number } = {},
): PerformanceMoment[] {
  const minSec = options.minSec ?? 20;
  const maxSec = options.maxSec ?? 40;
  const seconds = secondLevels(levels);
  const sections = musicSectionsFromLevels(levels, words);
  const moments: PerformanceMoment[] = [];
  const average = (from: number, to: number) => {
    let sum = 0;
    let n = 0;
    for (let s = Math.max(0, Math.floor(from)); s < Math.min(seconds.length, Math.ceil(to)); s++) {
      sum += seconds[s]!;
      n++;
    }
    return n ? sum / n : 0;
  };
  const overall = average(0, seconds.length) || 1e-6;

  sections.forEach((section, index) => {
    const length = section.end - section.start;
    if (length < minSec * 0.75) return;
    // Loudest window of the target length inside the song.
    const window = Math.min(maxSec, Math.max(minSec, Math.round(length * 0.5)), length);
    let bestStart = section.start;
    let bestLevel = -1;
    for (let s = section.start; s + window <= section.end; s++) {
      const level = average(s, s + window);
      if (level > bestLevel) {
        bestLevel = level;
        bestStart = s;
      }
    }
    const start = snapToDip(seconds, bestStart, section.start, section.end - minSec);
    const end = snapToDip(seconds, start + window, start + minSec, section.end);
    // Crowd reaction: how loud the few seconds right after the song are.
    const applause = average(section.end, section.end + 5) / overall;
    moments.push({ kind: "highlight", start, end, score: bestLevel / overall + applause * 0.5, title: `Performance ${index + 1}` });

    // Talk then play: the sentence(s) just before the song, then the song's start.
    const before = words.filter((w) => !w.deleted && w.end <= section.start + 0.5 && w.end > section.start - 4);
    if (before.length) {
      let talkStart = before[0]!.start;
      for (let i = words.indexOf(before[0]!) - 1; i >= 0; i--) {
        const word = words[i]!;
        if (word.deleted) continue;
        if (talkStart - word.end > 1.2 || section.start - word.start > 18) break;
        talkStart = word.start;
      }
      const playEnd = Math.min(section.end, section.start + Math.max(12, 30 - (section.start - talkStart)));
      moments.push({
        kind: "talk-then-play",
        start: Math.max(0, talkStart - 0.2),
        end: snapToDip(seconds, playEnd, section.start + 8, section.end),
        score: bestLevel / overall,
        title: `Explains, then plays ${index + 1}`,
      });
    }
  });
  return moments.sort((a, b) => b.score - a.score).slice(0, options.count ?? 10);
}

export async function findPerformanceMomentsInFile(file: File, words: readonly WordCue[], options?: { count?: number }) {
  return findPerformanceMoments(await frameLevels(file), words, options);
}

/** As AI clips (time-based: songs often have no words to anchor to). */
export function momentsToClips(moments: readonly PerformanceMoment[], firstIndex: number): ClipperClipPayload[] {
  return moments.map((moment, offset) => ({
    index: firstIndex + offset,
    startSec: moment.start,
    endSec: moment.end,
    label: moment.title,
    segments: [{ orderIndex: 0, startSec: moment.start, endSec: moment.end }],
  }));
}
