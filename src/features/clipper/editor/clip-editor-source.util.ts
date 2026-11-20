import type { ClipperGeneratedClip } from "../engine/segmentation";
import { segmentsTotalDuration } from "../engine/segmentation/clip-time.util";
import { resolveClipperOutputSize } from "../engine/render/frame-draw.util";
import type { ClipperFrameContext } from "../engine/render/index";
import type { ClipFramingTrack } from "../engine/render/framing-override.util";
import type { FrameEffectSize } from "../lib/media/video-frame-effect.util";
import { buildFrameContextForClip } from "../pipeline/frame-context.util";
import { computeClipRenderSignature } from "../pipeline/render-signature.util";
import { clipsForSourceMode, getActiveClips, type ClipperSession } from "../pipeline/session.util";
import type { ClipperSettings } from "../settings/settings.util";
import { getClipperFormatDef, type ClipperFormatDef } from "../shared/formats.util";
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEdit } from "./clip-edit.util";

/**
 * Everything the editor needs to re-render a clip from the project's source video, so
 * captions and framing can be changed (they are burned into exported files).
 */
export interface ClipEditorSource {
  rangeFile: File;
  rangeVideoUrl: string;
  clip: ClipperGeneratedClip;
  formatDef: ClipperFormatDef;
  /** Render context with the project's current framing and captions. */
  frameContext: ClipperFrameContext;
  outputSize: FrameEffectSize;
  /** Clip-local duration; matches the export's duration. */
  duration: number;
  /** The clip's framing as saved on the project. */
  framingTrack: ClipFramingTrack;
  /** Shot changes the AI found in this clip (clip-local). */
  aiShotBoundaries: number[];
  /** Render-input fingerprint of the clip as it would render now (see render-signature.util). */
  renderSignature: string;
}

const BOUNDS_TOLERANCE_SEC = 0.05;

function matchesBounds(clip: ClipperGeneratedClip, result: ClipperFormatResult): boolean {
  if (result.clipStartSec == null || result.clipEndSec == null) return false;
  return (
    Math.abs(clip.startSec - result.clipStartSec) <= BOUNDS_TOLERANCE_SEC &&
    Math.abs(clip.endSec - result.clipEndSec) <= BOUNDS_TOLERANCE_SEC
  );
}

/** Finds the clip an export was rendered from, even if the project switched clip modes since. */
function findExportClip(session: ClipperSession, result: ClipperFormatResult): ClipperGeneratedClip | null {
  const active = getActiveClips(session);
  const lists = [active, ...(["auto-parts", "ai", "manual"] as const).map((mode) => clipsForSourceMode(session, mode))];
  const byIndexAndBounds = active.find((clip) => clip.index === result.clipIndex && matchesBounds(clip, result));
  if (byIndexAndBounds) return byIndexAndBounds;
  for (const list of lists) {
    const match = list.find((clip) => matchesBounds(clip, result));
    if (match) return match;
  }
  // Older exports carry no bounds; trust the index only then.
  if (result.clipStartSec == null) return active.find((clip) => clip.index === result.clipIndex) ?? null;
  return null;
}

export function resolveClipEditorSourceForClip(
  session: ClipperSession,
  settings: ClipperSettings,
  clip: ClipperGeneratedClip,
  formatId: string,
): ClipEditorSource | null {
  if (!session.rangeTrimmedFile || !session.rangeTrimmedVideoUrl) return null;
  const formatDef = getClipperFormatDef(formatId);
  if (!formatDef || clip.segments.length === 0) return null;
  const frameContext = buildFrameContextForClip(session, settings, clip);
  return {
    rangeFile: session.rangeTrimmedFile,
    rangeVideoUrl: session.rangeTrimmedVideoUrl,
    clip,
    formatDef,
    frameContext,
    outputSize: resolveClipperOutputSize(formatDef, settings.formats.resolutionCap),
    duration: segmentsTotalDuration(clip.segments),
    framingTrack: frameContext.framing?.track ?? { keyframes: [], extraShotBoundaries: [] },
    aiShotBoundaries: frameContext.framing?.aiShotBoundaries ?? [],
    renderSignature: computeClipRenderSignature(session, settings, clip),
  };
}

export function resolveClipEditorSource(
  session: ClipperSession | null,
  settings: ClipperSettings,
  result: ClipperFormatResult,
): ClipEditorSource | null {
  if (!session) return null;
  const clip = findExportClip(session, result);
  if (!clip) return null;
  return resolveClipEditorSourceForClip(session, settings, clip, result.formatId);
}

/** The source frame context with the edit's captions, caption visibility and framing applied. */
export function applyEditToFrameContext(base: ClipperFrameContext, edit: ClipEdit): ClipperFrameContext {
  const captionsEnabled = edit.captionsVisible ?? base.settings.captions.enabled;
  return {
    ...base,
    settings:
      captionsEnabled === base.settings.captions.enabled && !edit.captionStyle
        ? base.settings
        : { ...base.settings, captions: { ...base.settings.captions, ...edit.captionStyle, enabled: captionsEnabled } },
    captionGroups: edit.captionGroups ?? base.captionGroups,
    colorGrade: edit.colorGrade ?? base.colorGrade ?? null,
    framing: edit.framing
      ? { track: edit.framing, aiShotBoundaries: base.framing?.aiShotBoundaries ?? [] }
      : base.framing,
  };
}

/** What export rows need from the session to open the editor with source access. */
export interface ClipEditorBridge {
  getSource: (result: ClipperFormatResult) => ClipEditorSource | null;
  saveFraming: (clip: ClipperGeneratedClip, track: ClipFramingTrack) => Promise<void>;
}
