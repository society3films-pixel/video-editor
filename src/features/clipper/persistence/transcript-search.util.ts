/** Searches the saved transcripts of every Clipper project for a word or phrase. */
import { projectsService } from "../../../services/projects.service";
import type { WordCue } from "../lib/media/transcription-export.util";
import { fetchClipperRangeWords } from "./clipper-range-words-api.util";
import { fetchClipperClips, saveClipperClips } from "./clipper-clips-api.util";
import { clipPicksToPayload } from "../editor/ai-editor/ai-clip-pick.util";

export interface TranscriptMatch {
  projectId: string;
  projectName: string;
  /** Index of the first matched word. */
  wordIndex: number;
  wordCount: number;
  /** Range-source time of the match. */
  time: number;
  before: string;
  match: string;
  after: string;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "").replace(/'/g, "");

/** Matches of `query` (all its words in a row, ignoring case and punctuation) in `words`. */
export function findPhrase(words: readonly WordCue[], query: string): number[] {
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean);
  if (!tokens.length) return [];
  const spoken = words.map((word) => (word.deleted ? "" : normalize(word.text)));
  const hits: number[] = [];
  for (let i = 0; i + tokens.length <= spoken.length; i++) {
    let ok = true;
    for (let j = 0; j < tokens.length; j++) {
      // The last token may be a prefix ("pric" finds "pricing").
      const word = spoken[i + j]!;
      if (j === tokens.length - 1 ? !word.startsWith(tokens[j]!) : word !== tokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

const wordCache = new Map<string, WordCue[]>();

export async function searchAllTranscripts(query: string, options: { limit?: number } = {}): Promise<TranscriptMatch[]> {
  const limit = options.limit ?? 200;
  const response = await projectsService.getAll(1, 500, "", "clipper", "updatedAt");
  const tokens = query.split(/\s+/).filter(Boolean).length;
  const results: TranscriptMatch[] = [];
  for (const project of response.data) {
    let words = wordCache.get(project.id);
    if (!words) {
      words = await fetchClipperRangeWords(project.id);
      wordCache.set(project.id, words);
    }
    const text = (from: number, to: number) => words!.slice(Math.max(0, from), Math.max(0, to)).filter((w) => !w.deleted).map((w) => w.text).join(" ");
    for (const index of findPhrase(words, query)) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        wordIndex: index,
        wordCount: tokens,
        time: words[index]!.start,
        before: text(index - 8, index),
        match: text(index, index + tokens),
        after: text(index + tokens, index + tokens + 10),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

/** About `targetSec` around a match: from the start of its sentence to the end of a later one. */
export function clipAroundMatch(words: readonly WordCue[], index: number, targetSec = 30): { from: number; to: number } {
  const endsSentence = (i: number) => /[.!?…]["')\]]*$/.test(words[i]?.text ?? "") || (words[i + 1] ? words[i + 1]!.start - words[i]!.end > 0.8 : true);
  let from = index;
  while (from > 0 && !endsSentence(from - 1) && words[index]!.start - words[from - 1]!.start < 20) from--;
  let to = index;
  while (to < words.length - 1 && (words[to]!.end - words[from]!.start < targetSec || !endsSentence(to)) && words[to]!.end - words[from]!.start < targetSec * 2) to++;
  return { from, to };
}

/** Saves a clip around the match as an AI clip of its project (Preview → AI clips). */
export async function makeClipFromMatch(match: TranscriptMatch): Promise<void> {
  const words = wordCache.get(match.projectId) ?? (await fetchClipperRangeWords(match.projectId));
  const span = clipAroundMatch(words, match.wordIndex);
  const existing = await fetchClipperClips(match.projectId, "ai");
  const firstIndex = existing.reduce((max, clip) => Math.max(max, clip.index + 1), 0);
  const [payload] = clipPicksToPayload(
    [{ title: `“${match.match}”`, reason: "From transcript search", segments: [span], durationSec: words[span.to]!.end - words[span.from]!.start }],
    words,
    firstIndex,
  );
  await saveClipperClips(match.projectId, "ai", [...existing, payload!]);
}
