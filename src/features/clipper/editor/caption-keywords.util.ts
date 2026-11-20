/** Keyword emphasis in captions: picking and toggling the words drawn in the highlight colour. */
import type { CaptionGroup } from "../lib/media/transcription-export.util";

const STOP_WORDS = new Set(
  (
    "a an the and or but so if then than that this these those there here is are was were be been being am do does did " +
    "have has had i me my mine you your yours he him his she her hers it its we us our they them their what which who whom " +
    "whose when where why how all any both each few more most other some such no nor not only own same too very can will " +
    "just should now of at by for with about against between into through during before after above below to from up down " +
    "in out on off over under again further once also like really actually basically literally gonna wanna gotta yeah okay " +
    "ok oh um uh well right know mean think thing things stuff something anything everything going get got getting say said " +
    "would could might must shall let lets dont doesnt didnt cant wont isnt arent wasnt im youre hes shes were theyre ive " +
    "youve weve theyve ill youll hell shell well theyll id youd hed shed wed theyd one two"
  ).split(" "),
);

function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}%$€£]/gu, "");
}

/** How much a word stands out; 0 = never a keyword. */
export function keywordScore(text: string, isFirstInGroup: boolean): number {
  const word = bare(text);
  if (!word || STOP_WORDS.has(word)) return 0;
  if (/\d/.test(word) || /[%$€£]/.test(word)) return 10; // numbers, money and percentages
  let score = Math.min(word.length, 10) - 3;
  if (!isFirstInGroup && /^\p{Lu}/u.test(text.trim())) score += 3; // names and places
  if (/!$/.test(text.trim())) score += 2;
  return score >= 3 ? score : 0;
}

/**
 * Marks at most one keyword per caption line (the strongest), skipping short lines and lines
 * right after one that already has a keyword, so emphasis stays meaningful. Clears old marks.
 */
export function highlightKeywords(groups: readonly CaptionGroup[]): { groups: CaptionGroup[]; count: number } {
  let count = 0;
  let previousHadKeyword = false;
  const next = groups.map((group) => {
    let best = -1;
    let bestScore = 0; // ties go to the later word: the end of a phrase carries the stress
    group.words.forEach((word, index) => {
      if (word.deleted) return;
      const score = keywordScore(word.text, index === 0);
      if (score > 0 && score >= bestScore) {
        best = index;
        bestScore = score;
      }
    });
    const pick = group.words.length >= 2 && best >= 0 && (bestScore >= 8 || !previousHadKeyword);
    previousHadKeyword = pick;
    if (pick) count++;
    return {
      ...group,
      words: group.words.map((word, index) => {
        const { emphasis: _old, ...rest } = word;
        void _old;
        return pick && index === best ? { ...rest, emphasis: true } : rest;
      }),
    };
  });
  return { groups: next, count };
}

export function toggleWordEmphasis(groups: readonly CaptionGroup[], groupIndex: number, wordIndex: number): CaptionGroup[] {
  return groups.map((group, gi) =>
    gi !== groupIndex
      ? group
      : { ...group, words: group.words.map((word, wi) => (wi === wordIndex ? { ...word, emphasis: !word.emphasis || undefined } : word)) },
  );
}

export function clearKeywords(groups: readonly CaptionGroup[]): CaptionGroup[] {
  return groups.map((group) => ({
    ...group,
    words: group.words.map((word) => {
      const { emphasis: _old, ...rest } = word;
      void _old;
      return rest;
    }),
  }));
}

export function countKeywords(groups: readonly CaptionGroup[]): number {
  return groups.reduce((sum, group) => sum + group.words.filter((word) => word.emphasis).length, 0);
}
