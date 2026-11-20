/**
 * A project's B-roll library: shots (images, videos) with tags. Tags come from the file name and,
 * with an AI set up, from a vision model looking at a frame. The library suggests where shots fit
 * a clip: a tag matching what's being said ("my first guitar" → guitar shot).
 */
import { VideoSampleSink } from "mediabunny";
import { localRecordGet, localRecordPut } from "../../../shared/persistence/local-database.util";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import type { WordCue } from "../lib/media/transcription-export.util";
import type { AiChoice } from "./ai-editor/ai-choice.util";
import { requestEdit } from "./ai-editor/ai-editor-providers.util";
import { assetBlob, loadEditorAsset, saveEditorAsset } from "./editor-assets.util";
import { createEditId, sourceToOutputTime, type ClipEdit } from "./clip-edit.util";
import type { ClipInsert } from "./broll.util";

export interface BrollItem {
  id: string;
  assetId: string;
  name: string;
  kind: "image" | "video";
  tags: string[];
  durationSec: number | null;
  /** Small JPEG data URL for the list. */
  thumb: string | null;
}

const NAMESPACE = "clipper-broll-library";
const NOISE = new Set(["img", "dsc", "mov", "mp4", "clip", "final", "edit", "copy", "video", "broll", "b", "roll", "shot", "take", "cam", "the", "and", "of"]);

export async function loadBrollLibrary(projectId: string): Promise<BrollItem[]> {
  return (await localRecordGet<BrollItem[]>(NAMESPACE, projectId).catch(() => null)) ?? [];
}

export async function saveBrollLibrary(projectId: string, items: BrollItem[]): Promise<BrollItem[]> {
  await localRecordPut(NAMESPACE, projectId, projectId, items);
  return items;
}

/** Tags from a file name: "Guitar_closeup-02.mp4" → guitar, closeup. */
export function tagsFromName(name: string): string[] {
  return [
    ...new Set(
      name
        .replace(/\.[^.]+$/, "")
        .split(/[^\p{L}]+/u)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length >= 3 && !NOISE.has(w)),
    ),
  ];
}

async function thumbnail(file: File, kind: BrollItem["kind"]): Promise<{ dataUrl: string; base64: string } | null> {
  const canvas = new OffscreenCanvas(320, 180);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let width = 0;
  let height = 0;
  if (kind === "image") {
    const bitmap = await createImageBitmap(await assetBlob(file));
    width = bitmap.width;
    height = bitmap.height;
    const scale = Math.min(320 / width, 180 / height);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  } else {
    const input = await createMediabunnyInput(file);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return null;
      const duration = await input.computeDuration();
      const sample = await new VideoSampleSink(track).getSample(Math.min(1, duration / 3));
      if (!sample) return null;
      const scale = Math.min(320 / sample.displayWidth, 180 / sample.displayHeight);
      canvas.width = Math.round(sample.displayWidth * scale);
      canvas.height = Math.round(sample.displayHeight * scale);
      sample.draw(ctx, 0, 0, canvas.width, canvas.height);
      sample.close();
    } finally {
      input.dispose();
    }
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const base64 = btoa(binary);
  return { dataUrl: `data:image/jpeg;base64,${base64}`, base64 };
}

async function videoDuration(file: File): Promise<number | null> {
  const input = await createMediabunnyInput(file);
  try {
    return await input.computeDuration();
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

export async function addBrollFiles(projectId: string, files: readonly File[]): Promise<BrollItem[]> {
  const items = await loadBrollLibrary(projectId);
  for (const file of files) {
    const kind = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name) ? "video" : "image";
    const assetId = await saveEditorAsset(file);
    const thumb = await thumbnail(file, kind).catch(() => null);
    items.push({
      id: createEditId("broll-item"),
      assetId,
      name: file.name,
      kind,
      tags: tagsFromName(file.name),
      durationSec: kind === "video" ? await videoDuration(file) : null,
      thumb: thumb?.dataUrl ?? null,
    });
  }
  return saveBrollLibrary(projectId, items);
}

const TAG_PROMPT = `List what this video frame shows, for finding B-roll in a music interview edit: instruments, objects, places, people's activity, mood. Reply with JSON only: {"tags": ["guitar", "stage", "crowd", ...]} with 4-10 short lowercase tags (single words where possible).`;

/** Adds tags from a vision model (Claude, or a local vision model such as Qwen-VL / LLaVA). */
export async function tagWithAi(choice: AiChoice, item: BrollItem): Promise<string[]> {
  const file = await loadEditorAsset(item.assetId);
  if (!file) throw new Error(`"${item.name}" is no longer saved; add it again.`);
  const thumb = await thumbnail(file, item.kind);
  if (!thumb) throw new Error(`Couldn't read a frame from "${item.name}".`);
  const reply = await requestEdit(choice.provider, choice.model, [{ role: "user", content: TAG_PROMPT }], undefined, {
    mediaType: "image/jpeg",
    base64: thumb.base64,
  });
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  const tags = start >= 0 && end > start ? (JSON.parse(reply.slice(start, end + 1)) as { tags?: unknown }).tags : null;
  if (!Array.isArray(tags)) throw new Error("The AI didn't return tags (does the model support images?).");
  return [...new Set([...item.tags, ...tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)])];
}

export interface BrollSuggestion {
  item: BrollItem;
  tag: string;
  /** Main-edit output time where the word is said. */
  outputTime: number;
  word: string;
}

const stem = (word: string) => word.toLowerCase().replace(/[^\p{L}]/gu, "").replace(/(ing|es|s)$/, "");

/** Shots whose tags match words said in the kept parts, at least 4 s apart, one per shot. */
export function suggestBroll(edit: ClipEdit, words: readonly WordCue[], library: readonly BrollItem[]): BrollSuggestion[] {
  const byStem = new Map<string, { item: BrollItem; tag: string }>();
  for (const item of library) for (const tag of item.tags) if (stem(tag).length >= 3) byStem.set(stem(tag), { item, tag });
  const kept = (t: number) => edit.segments.some((s) => t >= s.start && t < s.end);
  const covered = (t: number) => (edit.inserts ?? []).some((insert) => t >= insert.start - 1 && t < insert.end + 1);
  const used = new Set<string>();
  const suggestions: BrollSuggestion[] = [];
  let last = -Infinity;
  for (const word of words) {
    if (word.deleted || !kept(word.start)) continue;
    const match = byStem.get(stem(word.text));
    if (!match || used.has(match.item.id)) continue;
    const outputTime = sourceToOutputTime(edit.segments, word.start);
    if (outputTime - last < 4 || covered(outputTime)) continue;
    suggestions.push({ item: match.item, tag: match.tag, outputTime, word: word.text });
    used.add(match.item.id);
    last = outputTime;
  }
  return suggestions;
}

/** A B-roll insert for a suggestion: from just before the word, about 3 s (or the shot's length). */
export function insertForSuggestion(suggestion: BrollSuggestion, outputDuration: number): ClipInsert {
  const start = Math.max(0, suggestion.outputTime - 0.2);
  const length = Math.min(3.5, suggestion.item.durationSec ?? 3);
  return {
    id: createEditId("broll"),
    assetId: suggestion.item.assetId,
    name: suggestion.item.name,
    kind: suggestion.item.kind,
    start,
    end: Math.min(outputDuration, start + Math.max(1.5, length)),
    layout: "top",
  };
}
