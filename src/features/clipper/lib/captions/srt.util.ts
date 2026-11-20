/** SubRip (.srt) captions from caption lines. */
import type { CaptionGroup } from "../media/transcription-export.util";

export function srtTimestamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function captionGroupsToSrt(groups: readonly CaptionGroup[]): string {
  const entries: string[] = [];
  for (const group of groups) {
    const words = group.words.filter((word) => !word.deleted && word.text.trim());
    if (!words.length) continue;
    const start = words[0]!.start;
    const end = Math.max(start + 0.2, words[words.length - 1]!.end);
    entries.push(`${entries.length + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${words.map((w) => w.text).join(" ")}\n`);
  }
  return entries.join("\n");
}
