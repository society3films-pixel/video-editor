import type { CaptionGroup } from "../lib/media/transcription-export.util";
import { normalizeCaptionPresetId } from "../lib/captions/caption-presets.util";
import { COLOR_STYLE_LABEL } from "../engine/render/color-grade.util";
import {
  MIN_SEGMENT_SEC,
  type ClipEdit,
  type ClipCover,
  type ClipEditSegment,
  type ClipMusic,
  type ClipProgressBar,
  type ClipSoundEffects,
  type ClipTextOverlay,
} from "./clip-edit.util";

/**
 * The part of a clip edit saved with an edited export. Framing is not included: it belongs to
 * the clip and is saved on the project (see pipeline/clip-framing.util).
 */
export type PersistedClipEdit = Omit<ClipEdit, "framing">;

export function toPersistedClipEdit(edit: ClipEdit): PersistedClipEdit {
  const { framing: _framing, ...rest } = edit;
  void _framing;
  return rest;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates a saved edit against the clip's duration; returns null when it can't be used. */
export function fromPersistedClipEdit(raw: unknown, duration: number): Omit<ClipEdit, "framing"> | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PersistedClipEdit>;
  const segments = (Array.isArray(value.segments) ? value.segments : [])
    .filter((s): s is ClipEditSegment => Boolean(s) && isFiniteNumber(s.start) && isFiniteNumber(s.end) && typeof s.id === "string")
    .map((s) => ({
      id: s.id,
      start: Math.max(0, s.start),
      end: Math.min(duration, s.end),
      ...(isFiniteNumber(s.zoom) && s.zoom > 1 ? { zoom: Math.min(2, s.zoom) } : {}),
      ...(s.zoomCenter && isFiniteNumber(s.zoomCenter.x) && isFiniteNumber(s.zoomCenter.y)
        ? { zoomCenter: { x: Math.min(1, Math.max(0, s.zoomCenter.x)), y: Math.min(1, Math.max(0, s.zoomCenter.y)) } }
        : {}),
    }))
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SEC)
    .sort((a, b) => a.start - b.start);
  if (segments.length === 0) return null;
  const textOverlays = (Array.isArray(value.textOverlays) ? value.textOverlays : []).filter(
    (o): o is ClipTextOverlay => Boolean(o) && typeof o.text === "string" && isFiniteNumber(o.start) && isFiniteNumber(o.end),
  );
  const captionGroups = Array.isArray(value.captionGroups) ? (value.captionGroups as CaptionGroup[]) : null;
  return {
    segments,
    volume: isFiniteNumber(value.volume) ? Math.min(2, Math.max(0, value.volume)) : 1,
    fadeInSec: isFiniteNumber(value.fadeInSec) ? Math.max(0, value.fadeInSec) : 0,
    fadeOutSec: isFiniteNumber(value.fadeOutSec) ? Math.max(0, value.fadeOutSec) : 0,
    textOverlays,
    captionGroups,
    captionsVisible: typeof value.captionsVisible === "boolean" ? value.captionsVisible : null,
    music: parseMusic(value.music),
    sfx: parseSfx(value.sfx),
    progressBar: parseProgressBar(value.progressBar),
    cover: parseCover(value.cover),
    colorGrade:
      value.colorGrade && typeof value.colorGrade.style === "string" && value.colorGrade.style in COLOR_STYLE_LABEL
        ? {
            style: value.colorGrade.style,
            intensity: isFiniteNumber(value.colorGrade.intensity) ? Math.min(1, Math.max(0, value.colorGrade.intensity)) : 1,
            auto:
              value.colorGrade.auto && isFiniteNumber(value.colorGrade.auto.brightness)
                ? {
                    brightness: value.colorGrade.auto.brightness,
                    contrast: isFiniteNumber(value.colorGrade.auto.contrast) ? value.colorGrade.auto.contrast : 1,
                    saturation: isFiniteNumber(value.colorGrade.auto.saturation) ? value.colorGrade.auto.saturation : 1,
                    warmth: isFiniteNumber(value.colorGrade.auto.warmth) ? value.colorGrade.auto.warmth : 0,
                  }
                : null,
          }
        : null,
    captionStyle:
      value.captionStyle && typeof value.captionStyle.presetId === "string"
        ? {
            presetId: normalizeCaptionPresetId(value.captionStyle.presetId),
            position: ["top", "center", "bottom"].includes(value.captionStyle.position) ? value.captionStyle.position : "bottom",
            size: ["extra-small", "small", "medium", "large"].includes(value.captionStyle.size) ? value.captionStyle.size : "medium",
          }
        : null,
    inserts: (Array.isArray(value.inserts) ? value.inserts : [])
      .filter((i) => i && typeof i.assetId === "string" && isFiniteNumber(i.start) && isFiniteNumber(i.end) && i.end > i.start)
      .map((i) => ({
        id: typeof i.id === "string" ? i.id : `insert-${i.assetId}-${i.start}`,
        assetId: i.assetId,
        name: typeof i.name === "string" ? i.name : "B-roll",
        kind: i.kind === "video" ? ("video" as const) : ("image" as const),
        start: Math.max(0, i.start),
        end: i.end,
        layout: i.layout === "full" || i.layout === "pip" ? i.layout : ("top" as const),
      })),
    hook:
      value.hook && isFiniteNumber(value.hook.start) && isFiniteNumber(value.hook.end) && value.hook.end > value.hook.start
        ? { start: Math.max(0, value.hook.start), end: Math.min(duration, value.hook.end), text: typeof value.hook.text === "string" ? value.hook.text : "" }
        : null,
    bleeps: Array.isArray(value.bleeps)
      ? value.bleeps.filter((b) => b && isFiniteNumber(b.start) && isFiniteNumber(b.end) && b.end > b.start).map((b) => ({ start: b.start, end: b.end }))
      : [],
  };
}

function parseCover(raw: unknown): ClipCover | null {
  const value = raw as Partial<ClipCover> | null | undefined;
  if (!value || !isFiniteNumber(value.time)) return null;
  return {
    time: Math.max(0, value.time),
    title: typeof value.title === "string" ? value.title.slice(0, 120) : "",
    firstFrames: value.firstFrames === true,
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function parseMusic(raw: unknown): ClipMusic | null {
  const value = raw as Partial<ClipMusic> | null | undefined;
  if (!value || typeof value.assetId !== "string") return null;
  return {
    assetId: value.assetId,
    name: typeof value.name === "string" ? value.name : "Music",
    volume: isFiniteNumber(value.volume) ? clamp01(value.volume) : 0.25,
    duck: value.duck !== false,
    startSec: isFiniteNumber(value.startSec) ? Math.max(0, value.startSec) : 0,
  };
}

function parseSfx(raw: unknown): ClipSoundEffects | null {
  const value = raw as Partial<ClipSoundEffects> | null | undefined;
  if (!value || typeof value !== "object") return null;
  return { cuts: value.cuts === true, punchIns: value.punchIns === true, volume: isFiniteNumber(value.volume) ? clamp01(value.volume) : 0.6 };
}

function parseProgressBar(raw: unknown): ClipProgressBar | null {
  const value = raw as Partial<ClipProgressBar> | null | undefined;
  if (!value || typeof value !== "object") return null;
  return {
    position: value.position === "top" ? "top" : "bottom",
    color: typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : "#ffd400",
    thickness: isFiniteNumber(value.thickness) ? Math.min(0.03, Math.max(0.002, value.thickness)) : 0.008,
  };
}
