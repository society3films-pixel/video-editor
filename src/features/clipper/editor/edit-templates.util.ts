/**
 * Templates: a saved look (caption style, music, sound effects, progress bar, fades, keywords,
 * emoji, hook) applied to any clip in one click. Stored once for the whole app, not per project.
 */
import { localRecordGet, localRecordPut } from "../../../shared/persistence/local-database.util";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import { createEditId, type ClipCaptionStyle, type ClipEdit, type ClipMusic, type ClipProgressBar, type ClipSoundEffects } from "./clip-edit.util";
import { highlightKeywords } from "./caption-keywords.util";
import { addEmojiAutomatically } from "./caption-extras.util";
import { pickHookLocally } from "./hook.util";
import { COLOR_STYLE_LABEL, type ColorCorrection, type ColorStyle } from "../engine/render/color-grade.util";

export interface EditTemplate {
  id: string;
  name: string;
  createdAt: string;
  captionStyle: ClipCaptionStyle | null;
  /** Look only; the automatic correction is measured again for each clip it's applied to. */
  colorGrade?: { style: ColorStyle; intensity: number; auto: boolean } | null;
  music: ClipMusic | null;
  sfx: ClipSoundEffects | null;
  progressBar: ClipProgressBar | null;
  fadeInSec: number;
  fadeOutSec: number;
  /** Re-run on each clip it's applied to. */
  keywords: boolean;
  emoji: boolean;
  hook: boolean;
}

const NAMESPACE = "clipper-edit-templates";
const KEY = "all";

export async function loadTemplates(): Promise<EditTemplate[]> {
  return ((await localRecordGet<EditTemplate[]>(NAMESPACE, KEY).catch(() => null)) ?? []).filter((t) => t && typeof t.id === "string");
}

async function storeTemplates(templates: EditTemplate[]): Promise<EditTemplate[]> {
  await localRecordPut(NAMESPACE, KEY, null, templates);
  return templates;
}

/** The current edit's look as a template. Keywords/emoji/hook count as "on" when the edit has them. */
export function templateFromEdit(name: string, edit: ClipEdit): EditTemplate {
  const words = edit.captionGroups?.flatMap((group) => group.words) ?? [];
  return {
    id: createEditId("template"),
    name: name.trim() || "My template",
    createdAt: new Date().toISOString(),
    captionStyle: edit.captionStyle ?? null,
    colorGrade: edit.colorGrade ? { style: edit.colorGrade.style, intensity: edit.colorGrade.intensity, auto: Boolean(edit.colorGrade.auto) } : null,
    music: edit.music ?? null,
    sfx: edit.sfx ?? null,
    progressBar: edit.progressBar ?? null,
    fadeInSec: edit.fadeInSec,
    fadeOutSec: edit.fadeOutSec,
    keywords: words.some((word) => word.emphasis),
    emoji: words.some((word) => word.emoji),
    hook: Boolean(edit.hook),
  };
}

export async function saveTemplate(template: EditTemplate): Promise<EditTemplate[]> {
  const all = await loadTemplates();
  // Same name replaces, so re-saving updates a template.
  return storeTemplates([...all.filter((t) => t.name.toLowerCase() !== template.name.toLowerCase()), template]);
}

export async function deleteTemplate(id: string): Promise<EditTemplate[]> {
  return storeTemplates((await loadTemplates()).filter((t) => t.id !== id));
}

/** Applies a template to an edit. Caption steps work on `captionGroups` (the clip's current lines). */
export function applyTemplate(
  edit: ClipEdit,
  template: EditTemplate,
  inputs: { captionGroups: readonly CaptionGroup[]; words: readonly WordCue[]; duration: number; colorCorrection?: ColorCorrection | null },
): ClipEdit {
  let next: ClipEdit = {
    ...edit,
    colorGrade: template.colorGrade
      ? { style: template.colorGrade.style, intensity: template.colorGrade.intensity, auto: template.colorGrade.auto ? (inputs.colorCorrection ?? null) : null }
      : (edit.colorGrade ?? null),
    captionStyle: template.captionStyle,
    music: template.music,
    sfx: template.sfx,
    progressBar: template.progressBar,
    fadeInSec: template.fadeInSec,
    fadeOutSec: template.fadeOutSec,
  };
  let groups = [...(edit.captionGroups ?? inputs.captionGroups)];
  let groupsChanged = false;
  if (template.keywords && groups.length) {
    groups = highlightKeywords(groups).groups;
    groupsChanged = true;
  }
  if (template.emoji && groups.length) {
    groups = addEmojiAutomatically(groups).groups;
    groupsChanged = true;
  }
  if (groupsChanged) next = { ...next, captionGroups: groups };
  if (template.hook && !edit.hook) {
    const hook = pickHookLocally(inputs.words, inputs.duration);
    if (hook) next = { ...next, hook };
  }
  return next;
}

export function describeTemplate(template: EditTemplate): string {
  const parts = [
    template.captionStyle ? "caption style" : null,
    template.colorGrade ? `colour (${COLOR_STYLE_LABEL[template.colorGrade.style]}${template.colorGrade.auto ? " + auto" : ""})` : null,
    template.music ? `music (${template.music.name})` : null,
    template.sfx && (template.sfx.cuts || template.sfx.punchIns) ? "sound effects" : null,
    template.progressBar ? "progress bar" : null,
    template.fadeInSec || template.fadeOutSec ? "fades" : null,
    template.keywords ? "keywords" : null,
    template.emoji ? "emoji" : null,
    template.hook ? "hook" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing yet";
}
