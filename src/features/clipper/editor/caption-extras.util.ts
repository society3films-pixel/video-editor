/** Caption extras: emoji, swear-word masking and bleeps, and translation. */
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import type { AiChoice } from "./ai-editor/ai-choice.util";
import { requestEdit } from "./ai-editor/ai-editor-providers.util";
import { setCaptionGroupText } from "./clip-edit.util";

function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "").replace(/'/g, "");
}

// ---- Emoji ------------------------------------------------------------------------------------

/** Word stems to emoji. Checked as prefixes of the bare word, longest first. */
const EMOJI_STEMS: Array<[string, string]> = [
  ["money", "💰"], ["cash", "💵"], ["dollar", "💵"], ["rich", "🤑"], ["profit", "📈"], ["revenue", "📈"], ["grow", "📈"],
  ["sale", "🏷️"], ["price", "🏷️"], ["cost", "💸"], ["expensive", "💸"], ["cheap", "🪙"], ["invest", "📊"], ["stock", "📊"],
  ["business", "💼"], ["work", "💼"], ["job", "💼"], ["boss", "👔"], ["team", "🤝"], ["deal", "🤝"], ["partner", "🤝"],
  ["idea", "💡"], ["think", "🤔"], ["question", "❓"], ["why", "🤔"], ["secret", "🤫"], ["truth", "💯"], ["true", "💯"],
  ["love", "❤️"], ["heart", "❤️"], ["happy", "😊"], ["laugh", "😂"], ["funny", "😂"], ["joke", "😂"], ["crazy", "🤯"],
  ["insane", "🤯"], ["mind", "🧠"], ["brain", "🧠"], ["smart", "🧠"], ["learn", "📚"], ["book", "📚"], ["read", "📖"],
  ["school", "🎓"], ["study", "📚"], ["sad", "😢"], ["cry", "😭"], ["angry", "😡"], ["mad", "😡"], ["scared", "😱"],
  ["fear", "😱"], ["shock", "😱"], ["wow", "😮"], ["amazing", "🤩"], ["awesome", "🤩"], ["love", "😍"], ["beautiful", "😍"],
  ["fire", "🔥"], ["hot", "🔥"], ["win", "🏆"], ["winner", "🏆"], ["champion", "🏆"], ["best", "🥇"], ["first", "🥇"],
  ["goal", "🎯"], ["target", "🎯"], ["focus", "🎯"], ["fast", "⚡"], ["quick", "⚡"], ["speed", "⚡"], ["power", "⚡"],
  ["energy", "⚡"], ["strong", "💪"], ["gym", "💪"], ["workout", "🏋️"], ["fit", "💪"], ["health", "🩺"], ["doctor", "🩺"],
  ["sleep", "😴"], ["tired", "😴"], ["food", "🍔"], ["eat", "🍽️"], ["pizza", "🍕"], ["coffee", "☕"], ["drink", "🥤"],
  ["beer", "🍺"], ["party", "🎉"], ["celebrate", "🎉"], ["birthday", "🎂"], ["music", "🎵"], ["song", "🎵"], ["game", "🎮"],
  ["play", "🎮"], ["phone", "📱"], ["app", "📱"], ["computer", "💻"], ["code", "💻"], ["tech", "💻"], ["ai", "🤖"],
  ["robot", "🤖"], ["internet", "🌐"], ["world", "🌍"], ["travel", "✈️"], ["plane", "✈️"], ["car", "🚗"], ["drive", "🚗"],
  ["house", "🏠"], ["home", "🏠"], ["family", "👨‍👩‍👧"], ["kid", "🧒"], ["baby", "👶"], ["dog", "🐶"], ["cat", "🐱"],
  ["time", "⏰"], ["clock", "⏰"], ["late", "⏰"], ["day", "📅"], ["week", "📅"], ["year", "📅"], ["rocket", "🚀"],
  ["launch", "🚀"], ["start", "🚀"], ["future", "🔮"], ["magic", "✨"], ["star", "⭐"], ["light", "💡"], ["danger", "⚠️"],
  ["warning", "⚠️"], ["stop", "🛑"], ["no", "🚫"], ["never", "🚫"], ["yes", "✅"], ["right", "✅"], ["correct", "✅"],
  ["wrong", "❌"], ["mistake", "❌"], ["fail", "❌"], ["problem", "🧩"], ["solve", "🧩"], ["key", "🔑"], ["lock", "🔒"],
  ["water", "💧"], ["sun", "☀️"], ["rain", "🌧️"], ["cold", "🥶"], ["dead", "💀"], ["kill", "💀"], ["die", "💀"],
  ["god", "🙏"], ["pray", "🙏"], ["thank", "🙏"], ["please", "🙏"], ["eye", "👀"], ["look", "👀"], ["see", "👀"],
  ["watch", "👀"], ["listen", "👂"], ["talk", "🗣️"], ["speak", "🗣️"], ["say", "🗣️"], ["clap", "👏"], ["respect", "🫡"],
];
const SORTED_STEMS = [...EMOJI_STEMS].sort((a, b) => b[0].length - a[0].length);

export function emojiForWord(text: string): string | null {
  const word = bare(text);
  if (word.length < 2) return null;
  for (const [stem, emoji] of SORTED_STEMS) {
    if (stem.length <= 3 ? word === stem || word === `${stem}s` : word.startsWith(stem)) return emoji;
  }
  return null;
}

/**
 * Offline emoji: for each line, the first word with a matching emoji (keywords preferred), and at
 * most every other line so it doesn't get noisy. Replaces existing emoji.
 */
export function addEmojiAutomatically(groups: readonly CaptionGroup[]): { groups: CaptionGroup[]; count: number } {
  let count = 0;
  let previous = false;
  const next = groups.map((group) => {
    const words = group.words.map(({ emoji: _old, ...rest }) => {
      void _old;
      return rest as WordCue;
    });
    if (previous) {
      previous = false;
      return { ...group, words };
    }
    const candidates = words
      .map((word, index) => ({ index, emoji: word.deleted ? null : emojiForWord(word.text), keyword: Boolean(word.emphasis) }))
      .filter((c) => c.emoji);
    const pick = candidates.find((c) => c.keyword) ?? candidates[0];
    if (!pick) return { ...group, words };
    previous = true;
    count++;
    return { ...group, words: words.map((word, index) => (index === pick.index ? { ...word, emoji: pick.emoji! } : word)) };
  });
  return { groups: next, count };
}

export function setLineEmoji(groups: readonly CaptionGroup[], groupIndex: number, emoji: string | null): CaptionGroup[] {
  return groups.map((group, index) => {
    if (index !== groupIndex) return group;
    const words = group.words.map(({ emoji: _old, ...rest }) => {
      void _old;
      return rest as WordCue;
    });
    if (!emoji || !words.length) return { ...group, words };
    const target = Math.max(0, words.findIndex((word) => word.emphasis));
    return { ...group, words: words.map((word, i) => (i === target ? { ...word, emoji } : word)) };
  });
}

export function clearEmoji(groups: readonly CaptionGroup[]): CaptionGroup[] {
  return groups.map((group) => setLineEmoji([group], 0, null)[0]!);
}

export function countEmoji(groups: readonly CaptionGroup[]): number {
  return groups.filter((group) => group.words.some((word) => word.emoji)).length;
}

// ---- Swear words ------------------------------------------------------------------------------

const SWEAR_STEMS = [
  "fuck", "motherfuck", "shit", "bullshit", "bitch", "asshole", "bastard", "dick", "cunt", "pussy", "cock", "twat",
  "wanker", "bollocks", "prick", "slut", "whore", "damn", "goddamn", "crap", "piss", "douche", "jackass", "dumbass",
];
const SWEAR_EXACT = new Set(["ass", "arse", "fck", "fuk", "wtf", "stfu", "af", "dammit", "effing", "frick"]);
const NOT_SWEARS = new Set(["dickens", "cockpit", "cocktail", "peacock", "scrap", "scunthorpe", "assess", "classic", "passion", "bass", "grass", "mass", "pass", "class", "glass", "assume", "assist", "shitake", "shiitake", "dickson", "hancock", "babcock"]);

export function isSwearWord(text: string): boolean {
  const word = bare(text);
  if (!word || NOT_SWEARS.has(word)) return false;
  if (SWEAR_EXACT.has(word)) return true;
  return SWEAR_STEMS.some((stem) => word.startsWith(stem) || (stem.length >= 4 && word.includes(stem)));
}

/** "fucking" → "f*****g": first and last letter kept, punctuation untouched. */
export function maskWord(text: string): string {
  const chars = [...text];
  const positions = chars.map((char, index) => (/[\p{L}\p{N}]/u.test(char) ? index : -1)).filter((index) => index >= 0);
  // Short words keep only their first letter ("a**"); longer ones keep the last too.
  const keep = new Set(positions.length <= 3 ? [positions[0]] : [positions[0], positions[positions.length - 1]]);
  return chars.map((char, index) => (positions.includes(index) && !keep.has(index) ? "*" : char)).join("");
}

export function maskSwearWords(groups: readonly CaptionGroup[]): { groups: CaptionGroup[]; count: number } {
  let count = 0;
  const next = groups.map((group) => ({
    ...group,
    words: group.words.map((word) => {
      if (!isSwearWord(word.text)) return word;
      count++;
      return { ...word, text: maskWord(word.text), originalText: word.originalText ?? word.text };
    }),
  }));
  return { groups: next, count };
}

/** Time ranges (clip-local) of swear words to bleep, slightly padded. */
export function swearBleepRanges(words: readonly WordCue[]): Array<{ start: number; end: number }> {
  return words
    .filter((word) => !word.deleted && isSwearWord(word.originalText ?? word.text))
    .map((word) => ({ start: Math.max(0, word.start - 0.03), end: word.end + 0.03 }));
}

// ---- Translation ------------------------------------------------------------------------------

export const TRANSLATION_LANGUAGES = [
  "Spanish", "Portuguese", "French", "German", "Italian", "Dutch", "Polish", "Turkish", "Russian", "Ukrainian", "Arabic",
  "Hindi", "Indonesian", "Vietnamese", "Thai", "Japanese", "Korean", "Chinese (Simplified)", "English",
] as const;

export function buildTranslationMessages(groups: readonly CaptionGroup[], language: string) {
  const lines = groups.map((group, index) => `${index}: ${group.words.map((w) => w.text).join(" ")}`).join("\n");
  return [
    {
      role: "system" as const,
      content:
        `You translate short-video captions into ${language}. Keep each line short and natural for on-screen captions, ` +
        "keep the meaning and tone (including slang), keep numbers, names and brands. Translate line by line: same number " +
        'of lines, same order. Reply with JSON only: {"lines": ["...", "..."]}',
    },
    { role: "user" as const, content: lines },
  ];
}

export function parseTranslation(reply: string, expected: number): string[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return a translation.");
  let lines: unknown;
  try {
    lines = (JSON.parse(reply.slice(start, end + 1)) as { lines?: unknown }).lines;
  } catch {
    throw new Error("The AI's translation couldn't be read.");
  }
  if (!Array.isArray(lines) || lines.length !== expected) {
    throw new Error(`The AI returned ${Array.isArray(lines) ? lines.length : 0} lines for ${expected} captions. Try again.`);
  }
  return lines.map((line) => String(line ?? "").trim());
}

/** Translated captions with the original timing: each line's time is shared out over its new words. */
export function applyTranslation(groups: readonly CaptionGroup[], lines: readonly string[]): CaptionGroup[] {
  let next = [...groups];
  // Back to front, so removing an emptied line doesn't shift the indexes still to do.
  for (let index = groups.length - 1; index >= 0; index--) {
    const text = lines[index];
    if (text) next = setCaptionGroupText(next, index, text);
  }
  return next;
}

export async function translateCaptions(choice: AiChoice, groups: readonly CaptionGroup[], language: string, signal?: AbortSignal) {
  const reply = await requestEdit(choice.provider, choice.model, buildTranslationMessages(groups, language), signal);
  return applyTranslation(groups, parseTranslation(reply, groups.length));
}
