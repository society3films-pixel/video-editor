/**
 * Templates: a look (caption style, colour, music, sound effects, progress bar, fades, keywords,
 * emoji, hook, jump cuts, punch-ins) applied to any clip in one click. Built-in trending looks
 * ship with the app; your own are stored once for the whole app, not per project.
 */
import {
  localRecordGet,
  localRecordPut,
} from "../../../shared/persistence/local-database.util";
import type {
  CaptionGroup,
  WordCue,
} from "../lib/media/transcription-export.util";
import {
  createEditId,
  type ClipCaptionStyle,
  type ClipEdit,
  type ClipMusic,
  type ClipProgressBar,
  type ClipSoundEffects,
} from "./clip-edit.util";
import { highlightKeywords } from "./caption-keywords.util";
import { addEmojiAutomatically } from "./caption-extras.util";
import { pickHookLocally } from "./hook.util";
import {
  applyPunchIns,
  DEFAULT_PAUSE_CUT_OPTIONS,
  planPauseCuts,
} from "./auto-edit.util";
import {
  COLOR_STYLE_LABEL,
  type ColorCorrection,
  type ColorStyle,
} from "../engine/render/color-grade.util";

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
  /** Cut long pauses and filler words (jump cuts). Songs are left alone. */
  jumpCuts?: boolean;
  /** A slight zoom on every other part, so jump cuts read as intentional. */
  punchIns?: boolean;
  /** Ships with the app (can't be deleted or overwritten). */
  builtIn?: boolean;
  /** One line on what it's for (built-in looks). */
  description?: string;
}

const look = (
  id: string,
  name: string,
  description: string,
  caption: [
    ClipCaptionStyle["presetId"],
    ClipCaptionStyle["position"],
    ClipCaptionStyle["size"],
  ],
  rest: Partial<EditTemplate>,
): EditTemplate => ({
  id: `builtin-${id}`,
  name,
  description,
  createdAt: "2026-11-01T00:00:00.000Z",
  builtIn: true,
  captionStyle: {
    presetId: caption[0],
    position: caption[1],
    size: caption[2],
  },
  colorGrade: null,
  music: null,
  sfx: null,
  progressBar: null,
  fadeInSec: 0,
  fadeOutSec: 0,
  keywords: false,
  emoji: false,
  hook: false,
  ...rest,
});

const WHOOSH: ClipSoundEffects = { cuts: true, punchIns: true, volume: 0.5 };

/**
 * Ready-made looks in the styles short-form video uses now. Each sets the captions, colour,
 * pacing (jump cuts, punch-ins), sound effects and extras; music isn't included (it's yours).
 */
export const BUILT_IN_TEMPLATES: readonly EditTemplate[] = [
  look(
    "viral-talk",
    "Viral talking head",
    "Big bold captions mid-screen, key words highlighted, jump cuts and punch-ins, whooshes, a hook title and progress bar.",
    ["beast", "center", "large"],
    {
      colorGrade: { style: "vibrant", intensity: 0.45, auto: true },
      sfx: WHOOSH,
      progressBar: { position: "bottom", color: "#ffd400", thickness: 0.008 },
      keywords: true,
      hook: true,
      jumpCuts: true,
      punchIns: true,
    },
  ),
  look(
    "one-word",
    "One word at a time",
    "A single big word on screen at a time, tight jump cuts and punch-ins. Fast and punchy.",
    ["simple-one-word", "center", "large"],
    {
      colorGrade: { style: "vibrant", intensity: 0.35, auto: true },
      sfx: { cuts: true, punchIns: false, volume: 0.4 },
      jumpCuts: true,
      punchIns: true,
    },
  ),
  look(
    "podcast",
    "Podcast clip",
    "Clean captions low on screen with highlighted key words, pauses tightened, a hook title. For interviews and conversations.",
    ["podcast", "bottom", "medium"],
    {
      colorGrade: { style: "natural", intensity: 0.5, auto: true },
      keywords: true,
      hook: true,
      jumpCuts: true,
    },
  ),
  look(
    "emoji-pop",
    "Emoji pop",
    "Playful captions with emoji and highlighted words, jump cuts, punch-ins and pops.",
    ["pop", "center", "large"],
    {
      colorGrade: { style: "vibrant", intensity: 0.5, auto: true },
      sfx: WHOOSH,
      keywords: true,
      emoji: true,
      hook: true,
      jumpCuts: true,
      punchIns: true,
    },
  ),
  look(
    "kinetic",
    "Kinetic captions",
    "Animated captions that move with the words, punch-ins on every other cut.",
    ["kinetic-01", "center", "large"],
    {
      colorGrade: { style: "vibrant", intensity: 0.4, auto: true },
      sfx: WHOOSH,
      keywords: true,
      jumpCuts: true,
      punchIns: true,
    },
  ),
  look(
    "karaoke",
    "Karaoke lyrics",
    "Words light up as they're sung or said. For songs and performances; nothing is cut.",
    ["karaoke", "bottom", "medium"],
    {
      colorGrade: { style: "cinematic", intensity: 0.5, auto: true },
      fadeInSec: 0.3,
      fadeOutSec: 0.5,
    },
  ),
  look(
    "live",
    "Live performance",
    "Moody colour, small captions out of the way, soft fades. Lets the music carry it; nothing is cut.",
    ["capicola-plain", "bottom", "small"],
    {
      colorGrade: { style: "moody", intensity: 0.55, auto: true },
      fadeInSec: 0.4,
      fadeOutSec: 0.8,
    },
  ),
  look(
    "cinematic",
    "Cinematic story",
    "Soft captions, film-like colour, gentle fades and no jump cuts. For storytelling moments.",
    ["soft-ai", "bottom", "medium"],
    {
      colorGrade: { style: "cinematic", intensity: 0.65, auto: true },
      fadeInSec: 0.4,
      fadeOutSec: 0.6,
      hook: true,
    },
  ),
  look(
    "minimal",
    "Clean and minimal",
    "Plain small captions, natural colour. Lets the picture speak.",
    ["capicola-plain", "bottom", "small"],
    {
      colorGrade: { style: "natural", intensity: 0.4, auto: true },
      fadeInSec: 0.2,
      fadeOutSec: 0.3,
    },
  ),
];

const NAMESPACE = "clipper-edit-templates";
const KEY = "all";

/** The built-in trending looks first, then the ones you saved. */
export async function loadTemplates(): Promise<EditTemplate[]> {
  const saved = (
    (await localRecordGet<EditTemplate[]>(NAMESPACE, KEY).catch(() => null)) ??
    []
  ).filter((t) => t && typeof t.id === "string" && !t.builtIn);
  return [...BUILT_IN_TEMPLATES, ...saved];
}

async function storeTemplates(
  templates: EditTemplate[],
): Promise<EditTemplate[]> {
  const saved = templates.filter((t) => !t.builtIn);
  await localRecordPut(NAMESPACE, KEY, null, saved);
  return [...BUILT_IN_TEMPLATES, ...saved];
}

/** The current edit's look as a template. Keywords/emoji/hook count as "on" when the edit has them. */
export function templateFromEdit(name: string, edit: ClipEdit): EditTemplate {
  const words = edit.captionGroups?.flatMap((group) => group.words) ?? [];
  return {
    id: createEditId("template"),
    name: name.trim() || "My template",
    createdAt: new Date().toISOString(),
    captionStyle: edit.captionStyle ?? null,
    colorGrade: edit.colorGrade
      ? {
          style: edit.colorGrade.style,
          intensity: edit.colorGrade.intensity,
          auto: Boolean(edit.colorGrade.auto),
        }
      : null,
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

export async function saveTemplate(
  template: EditTemplate,
): Promise<EditTemplate[]> {
  const all = await loadTemplates();
  // Same name replaces, so re-saving updates a template (a built-in look's name gets "(mine)").
  const name = BUILT_IN_TEMPLATES.some(
    (t) => t.name.toLowerCase() === template.name.toLowerCase(),
  )
    ? `${template.name} (mine)`
    : template.name;
  const mine = { ...template, name, builtIn: false };
  return storeTemplates([
    ...all.filter((t) => t.name.toLowerCase() !== name.toLowerCase()),
    mine,
  ]);
}

export async function deleteTemplate(id: string): Promise<EditTemplate[]> {
  return storeTemplates((await loadTemplates()).filter((t) => t.id !== id));
}

/** Applies a template to an edit. Caption steps work on `captionGroups` (the clip's current lines). */
export function applyTemplate(
  edit: ClipEdit,
  template: EditTemplate,
  inputs: {
    captionGroups: readonly CaptionGroup[];
    words: readonly WordCue[];
    duration: number;
    colorCorrection?: ColorCorrection | null;
  },
): ClipEdit {
  let next: ClipEdit = {
    ...edit,
    colorGrade: template.colorGrade
      ? {
          style: template.colorGrade.style,
          intensity: template.colorGrade.intensity,
          auto: template.colorGrade.auto
            ? (inputs.colorCorrection ?? null)
            : null,
        }
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
  // Pacing: only on a clip that hasn't been cut by hand yet.
  const untouched =
    edit.segments.length === 1 &&
    edit.segments[0]!.start <= 0.01 &&
    edit.segments[0]!.end >= inputs.duration - 0.01;
  if (template.jumpCuts && untouched && inputs.words.length) {
    const plan = planPauseCuts(inputs.words, inputs.duration, {
      ...DEFAULT_PAUSE_CUT_OPTIONS,
      protectRanges: (edit.musicSections ?? []).map((section) => ({
        start: section.start,
        end: section.end,
      })),
    });
    if (plan && plan.segments.length > 1)
      next = { ...next, segments: plan.segments };
  }
  if (
    template.punchIns &&
    next.segments.length > 1 &&
    !next.segments.some((segment) => (segment.zoom ?? 1) > 1)
  ) {
    next = { ...next, segments: applyPunchIns(next.segments).segments };
  }
  if (template.hook && !edit.hook) {
    const hook = pickHookLocally(inputs.words, inputs.duration);
    if (hook) next = { ...next, hook };
  }
  return next;
}

export function describeTemplate(template: EditTemplate): string {
  const parts = [
    template.captionStyle ? "caption style" : null,
    template.colorGrade
      ? `colour (${COLOR_STYLE_LABEL[template.colorGrade.style]}${template.colorGrade.auto ? " + auto" : ""})`
      : null,
    template.music ? `music (${template.music.name})` : null,
    template.sfx && (template.sfx.cuts || template.sfx.punchIns)
      ? "sound effects"
      : null,
    template.progressBar ? "progress bar" : null,
    template.fadeInSec || template.fadeOutSec ? "fades" : null,
    template.keywords ? "keywords" : null,
    template.emoji ? "emoji" : null,
    template.hook ? "hook" : null,
    template.jumpCuts ? "jump cuts" : null,
    template.punchIns ? "punch-ins" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing yet";
}
