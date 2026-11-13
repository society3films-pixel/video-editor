import type { CaptionGroup } from "../lib/media/transcription-export.util";
import {
  CAPTION_ACTIVE_EFFECTS,
  CAPTION_ENTRANCES,
  CAPTION_FONT_FAMILIES,
  normalizeCaptionPresetId,
  type CaptionStyleCustom,
} from "../lib/captions/caption-presets.util";
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
      ...(typeof s.angle === "string" ? { angle: s.angle } : {}),
      ...(isFiniteNumber(s.audioOffset) && s.audioOffset !== 0 ? { audioOffset: Math.max(-2, Math.min(2, s.audioOffset)) } : {}),
      ...(s.zoomCenter && isFiniteNumber(s.zoomCenter.x) && isFiniteNumber(s.zoomCenter.y)
        ? { zoomCenter: { x: Math.min(1, Math.max(0, s.zoomCenter.x)), y: Math.min(1, Math.max(0, s.zoomCenter.y)) } }
        : {}),
    }))
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SEC)
    .sort((a, b) => a.start - b.start);
  if (segments.length === 0) return null;
  const textOverlays = (Array.isArray(value.textOverlays) ? value.textOverlays : [])
    .filter((o): o is ClipTextOverlay => Boolean(o) && typeof o.text === "string" && isFiniteNumber(o.start) && isFiniteNumber(o.end))
    .map((o) => ({
      ...o,
      style: o.style === "lower-third" || o.style === "title-card" ? o.style : undefined,
      subtitle: typeof o.subtitle === "string" ? o.subtitle : undefined,
      accent: typeof o.accent === "string" ? o.accent : undefined,
    }));
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
    musicSections: Array.isArray(value.musicSections)
      ? value.musicSections
          .filter((m) => m && isFiniteNumber(m.start) && isFiniteNumber(m.end) && m.end > m.start)
          .map((m) => ({ start: m.start, end: m.end, gain: isFiniteNumber(m.gain) ? m.gain : 1 }))
      : null,
    balanceMusic: value.balanceMusic === true,
    angles: Array.isArray(value.angles)
      ? value.angles
          .filter((a) => a && typeof a.id === "string" && typeof a.assetId === "string" && isFiniteNumber(a.offsetSec))
          .map((a) => ({
            id: a.id,
            assetId: a.assetId,
            name: typeof a.name === "string" ? a.name : "Angle",
            offsetSec: a.offsetSec,
            confidence: isFiniteNumber(a.confidence) ? a.confidence : 0,
            x: isFiniteNumber(a.x) ? a.x : 0.5,
            y: isFiniteNumber(a.y) ? a.y : 0.5,
            zoom: isFiniteNumber(a.zoom) ? a.zoom : 1,
          }))
      : [],
    angleForSongs: typeof value.angleForSongs === "string" ? value.angleForSongs : null,
    voiceCleanup:
      value.voiceCleanup && typeof value.voiceCleanup === "object"
        ? { denoise: value.voiceCleanup.denoise === true, compress: value.voiceCleanup.compress === true }
        : null,
    beatPulse:
      value.beatPulse && Array.isArray(value.beatPulse.beats)
        ? {
            beats: value.beatPulse.beats.filter(isFiniteNumber),
            strength: isFiniteNumber(value.beatPulse.strength) ? Math.min(0.1, Math.max(0.005, value.beatPulse.strength)) : 0.03,
            every: value.beatPulse.every === 2 ? 2 : 1,
            bpm: isFiniteNumber(value.beatPulse.bpm) ? value.beatPulse.bpm : 0,
          }
        : null,
    stabilize:
      value.stabilize && isFiniteNumber(value.stabilize.strength)
        ? { strength: Math.min(1, Math.max(0, value.stabilize.strength)) }
        : null,
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
            ...(value.captionStyle.custom && typeof value.captionStyle.custom === "object" ? { custom: parseCaptionCustom(value.captionStyle.custom) } : {}),
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

function parseCaptionCustom(raw: Record<string, unknown>): CaptionStyleCustom {
  const color = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);
  const custom: CaptionStyleCustom = {
    fontFamily: CAPTION_FONT_FAMILIES.includes(raw.fontFamily as never) ? (raw.fontFamily as CaptionStyleCustom["fontFamily"]) : undefined,
    fontWeight: [400, 600, 700, 800, 900].includes(raw.fontWeight as number) ? (raw.fontWeight as CaptionStyleCustom["fontWeight"]) : undefined,
    uppercase: typeof raw.uppercase === "boolean" ? raw.uppercase : undefined,
    textColor: color(raw.textColor),
    activeTextColor: color(raw.activeTextColor),
    activeColor: color(raw.activeColor),
    outlineColor: color(raw.outlineColor),
    outlineWidthEm: isFiniteNumber(raw.outlineWidthEm) ? Math.min(0.4, Math.max(0, raw.outlineWidthEm)) : undefined,
    activeEffect: CAPTION_ACTIVE_EFFECTS.includes(raw.activeEffect as never) ? (raw.activeEffect as CaptionStyleCustom["activeEffect"]) : undefined,
    entrance: CAPTION_ENTRANCES.includes(raw.entrance as never) ? (raw.entrance as CaptionStyleCustom["entrance"]) : undefined,
    plateStyle: raw.plateStyle === "group" || raw.plateStyle === "none" ? raw.plateStyle : undefined,
    plateColor: color(raw.plateColor),
  };
  return Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== undefined)) as CaptionStyleCustom;
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
