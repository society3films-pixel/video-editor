/**
 * One-click "Auto edit": plans pause/filler cuts, framing fixes, punch-in zooms, a hook title
 * and a volume level from data the app already has (word timings, face samples, the export's
 * audio). Everything becomes ordinary editor state, so the user can review and undo it.
 */
import { AudioBufferSink } from "mediabunny";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import { highlightKeywords } from "./caption-keywords.util";
import type { FaceBoxSample } from "../shared/face-samples.util";
import type { ClipperClipSegmentWindow } from "../engine/segmentation/segmentation.types";
import { selectDominantFacePair, facesFitSingleCrop } from "../engine/reframe/collage/track.util";
import {
  defaultScreenPanels,
  defaultSplitPanels,
  shotIndexAt,
  type ClipFramingKeyframe,
  type ClipFramingTrack,
} from "../engine/render/framing-override.util";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import {
  createEditId,
  createTextOverlay,
  framingShotBoundaries,
  MIN_SEGMENT_SEC,
  type ClipEdit,
  type ClipEditSegment,
} from "./clip-edit.util";

// ---- 1. Pauses and filler words ----------------------------------------------------------------

/** Spoken hesitations that are safe to cut. Deliberately excludes real words like "like" or "so". */
const FILLER_WORDS = new Set(["um", "umm", "ummm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm"]);

export interface PauseCutOptions {
  /** Gaps between words longer than this are shortened. */
  maxPauseSec: number;
  /** Kept before a word and after a word, so cuts don't clip speech. */
  leadSec: number;
  tailSec: number;
  removeFillers: boolean;
}

export const DEFAULT_PAUSE_CUT_OPTIONS: PauseCutOptions = {
  maxPauseSec: 0.45,
  leadSec: 0.1,
  tailSec: 0.18,
  removeFillers: true,
};

export function isFillerWord(text: string): boolean {
  return FILLER_WORDS.has(text.toLowerCase().replace(/[^a-z]/g, ""));
}

export interface PauseCutPlan {
  segments: ClipEditSegment[];
  removedSec: number;
  fillerCount: number;
}

/**
 * Kept parts of the clip with long pauses and filler words removed. Words are in clip-local
 * time (the same timeline as the export).
 */
export function planPauseCuts(
  words: readonly WordCue[],
  duration: number,
  options: PauseCutOptions = DEFAULT_PAUSE_CUT_OPTIONS,
): PauseCutPlan | null {
  const spoken = words.filter((word) => !word.deleted && word.end > word.start && word.text.trim());
  const fillerCount = options.removeFillers ? spoken.filter((word) => isFillerWord(word.text)).length : 0;
  const speech = spoken.filter((word) => !(options.removeFillers && isFillerWord(word.text)));
  if (speech.length === 0 || duration <= 0) return null;

  // Merge words into speech runs, splitting wherever the silence is too long.
  const runs: Array<{ start: number; end: number }> = [];
  for (const word of [...speech].sort((a, b) => a.start - b.start)) {
    const last = runs[runs.length - 1];
    if (last && word.start - last.end <= options.maxPauseSec) last.end = Math.max(last.end, word.end);
    else runs.push({ start: word.start, end: word.end });
  }

  // Pad each run and clamp so padded runs never overlap.
  const segments: ClipEditSegment[] = [];
  runs.forEach((run, index) => {
    const previous = segments[segments.length - 1];
    let start = Math.max(0, run.start - options.leadSec);
    const nextStart = runs[index + 1]?.start ?? Infinity;
    const end = Math.min(duration, run.end + options.tailSec, nextStart - options.leadSec / 2);
    if (previous && start < previous.end) start = previous.end;
    if (end - start >= MIN_SEGMENT_SEC) segments.push({ id: createEditId("seg"), start, end });
  });
  if (segments.length === 0) return null;

  const kept = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  return { segments, removedSec: Math.max(0, duration - kept), fillerCount };
}

// ---- 2. Framing fixes ----------------------------------------------------------------------

export interface FramingFixPlan {
  track: ClipFramingTrack;
  /** Shot indexes switched to AI-tracked split screen. */
  fixedShots: number[];
}

/** Share of a shot's two-person samples that must not fit one crop before it is split. */
const SPLIT_SHARE_THRESHOLD = 0.5;
const MIN_TWO_PERSON_SAMPLES = 3;

/** Maps a range-source time to clip-local time, or null when it falls outside the clip. */
export function rangeToLocal(segments: readonly ClipperClipSegmentWindow[], time: number): number | null {
  let offset = 0;
  for (const segment of segments) {
    if (time >= segment.startSec && time < segment.endSec) return offset + (time - segment.startSec);
    offset += segment.endSec - segment.startSec;
  }
  return null;
}

/**
 * Switches shots to AI-tracked split screen where two people are on screen but don't both fit
 * the output crop most of the time. Shots that already have the user's framing are left alone.
 */
/**
 * One small face near an edge or corner of a wide frame: the usual look of a screen recording or
 * slides with a presenter webcam overlay.
 */
export function looksLikeWebcamOverlay(sample: FaceBoxSample): boolean {
  if (sample.faces.length !== 1 || sample.frameW <= sample.frameH) return false;
  const face = sample.faces[0]!;
  const area = (face.width * face.height) / (sample.frameW * sample.frameH);
  const cx = (face.x + face.width / 2) / sample.frameW;
  const cy = (face.y + face.height / 2) / sample.frameH;
  return area < 0.02 && (cx < 0.25 || cx > 0.75) && (cy < 0.3 || cy > 0.6);
}

export function planFramingFixes(
  track: ClipFramingTrack,
  aiShotBoundaries: readonly number[],
  faceSamples: readonly FaceBoxSample[],
  clipSegments: readonly ClipperClipSegmentWindow[],
  duration: number,
  outputAspect: number,
): FramingFixPlan {
  const boundaries = framingShotBoundaries(track, aiShotBoundaries);
  const shotCount = boundaries.length + 1;
  const stats = Array.from({ length: shotCount }, () => ({ twoPerson: 0, dontFit: 0, samples: 0, webcam: 0 }));

  for (const sample of faceSamples) {
    const local = rangeToLocal(clipSegments, sample.time);
    if (local === null) continue;
    stats[shotIndexAt(boundaries, local)]!.samples++;
    if (looksLikeWebcamOverlay(sample)) stats[shotIndexAt(boundaries, local)]!.webcam++;
    if (sample.faces.length < 2) continue;
    const pair = selectDominantFacePair(sample.faces);
    if (!pair) continue;
    const shot = stats[shotIndexAt(boundaries, local)]!;
    shot.twoPerson++;
    if (!facesFitSingleCrop(pair, sample.frameW, sample.frameH, outputAspect)) shot.dontFit++;
  }

  const keyframed = new Set(track.keyframes.map((k) => shotIndexAt(boundaries, k.t)));
  const added: ClipFramingKeyframe[] = [];
  const fixedShots: number[] = [];
  stats.forEach((shot, index) => {
    if (keyframed.has(index)) return;
    // A screen recording with a small presenter cam: show the screen whole and the face apart.
    if (shot.samples >= MIN_TWO_PERSON_SAMPLES && shot.webcam / shot.samples >= 0.6) {
      const start = index === 0 ? 0 : boundaries[index - 1]!;
      const end = index < boundaries.length ? boundaries[index]! : duration;
      added.push({
        id: createEditId("kf"),
        t: (start + end) / 2,
        mode: "auto",
        x: 0,
        y: 0,
        zoom: 1,
        singleShot: false,
        split: defaultScreenPanels(),
        screen: true,
      });
      fixedShots.push(index);
      return;
    }
    if (shot.twoPerson < MIN_TWO_PERSON_SAMPLES) return;
    if (shot.dontFit / shot.twoPerson < SPLIT_SHARE_THRESHOLD) return;
    const start = index === 0 ? 0 : boundaries[index - 1]!;
    const end = index < boundaries.length ? boundaries[index]! : duration;
    added.push({
      id: createEditId("kf"),
      t: (start + end) / 2,
      mode: "auto",
      x: 0,
      y: 0,
      zoom: 1,
      singleShot: false,
      split: defaultSplitPanels(),
      splitFollow: true,
    });
    fixedShots.push(index);
  });

  return {
    track: added.length ? { ...track, keyframes: [...track.keyframes, ...added].sort((a, b) => a.t - b.t) } : track,
    fixedShots,
  };
}

// ---- 3. Punch-in zooms ---------------------------------------------------------------------

export const PUNCH_IN_ZOOM = 1.15;

/** Alternates a slight zoom on every other part, so jump cuts read as intentional. */
export function applyPunchIns(
  segments: readonly ClipEditSegment[],
  zoom = PUNCH_IN_ZOOM,
  centerFor?: (start: number, end: number) => { x: number; y: number } | null,
): { segments: ClipEditSegment[]; count: number } {
  let count = 0;
  const next = segments.map((segment, index) => {
    if (index % 2 === 1) {
      count++;
      const center = centerFor?.(segment.start, segment.end);
      return { ...segment, zoom, ...(center ? { zoomCenter: center } : {}) };
    }
    const { zoom: _zoom, zoomCenter: _center, ...rest } = segment;
    void _zoom;
    void _center;
    return rest;
  });
  return { segments: next, count };
}

// ---- 4. Hook title -------------------------------------------------------------------------

const HOOK_MAX_WORDS = 9;
const HOOK_MAX_CHARS = 60;

/** The clip's social title, or its first sentence trimmed to a short hook. */
export function pickHookText(words: readonly WordCue[], socialTitle?: string): string | null {
  const title = socialTitle?.trim();
  if (title) return title.length > HOOK_MAX_CHARS ? `${title.slice(0, HOOK_MAX_CHARS - 1).trimEnd()}…` : title;
  const picked: string[] = [];
  for (const word of words) {
    if (word.deleted || isFillerWord(word.text)) continue;
    const text = word.text.trim();
    if (!text) continue;
    picked.push(text);
    if (/[.!?]$/.test(text) || picked.length >= HOOK_MAX_WORDS) break;
  }
  if (picked.length < 3) return null;
  const sentence = picked.join(" ").replace(/[,;:]$/, "");
  const capped = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return picked.length >= HOOK_MAX_WORDS && !/[.!?]$/.test(capped) ? `${capped}…` : capped;
}

export const HOOK_DURATION_SEC = 2.8;

// ---- 5. Volume level -----------------------------------------------------------------------

/** Typical speech level for short-form video (RMS of the louder, speech-bearing blocks). */
const TARGET_SPEECH_DBFS = -18;
const BLOCK_SEC = 0.05;

/** Gain (linear) that brings the clip's speech to TARGET_SPEECH_DBFS, from an audio file. */
export async function measureLevelGain(file: File, signal?: AbortSignal): Promise<{ gain: number; measuredDb: number } | null> {
  const input = await createMediabunnyInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    // Decoded buffers are often shorter than a block (e.g. 1024 frames), so accumulate across them.
    const blocks: number[] = [];
    let blockSum = 0;
    let blockFrames = 0;
    for await (const { buffer } of new AudioBufferSink(track).buffers()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const blockSize = Math.max(1, Math.round(buffer.sampleRate * BLOCK_SEC));
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      for (let i = 0; i < buffer.length; i++) {
        let frame = 0;
        for (const data of channels) frame += data[i]! * data[i]!;
        blockSum += frame / channels.length;
        if (++blockFrames >= blockSize) {
          blocks.push(blockSum / blockFrames);
          blockSum = 0;
          blockFrames = 0;
        }
      }
    }
    return levelGainFromBlocks(blocks);
  } finally {
    input.dispose();
  }
}

/**
 * Speech level from per-block mean-square power: the average of the loudest 60% of non-silent
 * blocks (skipping pauses and room noise), then the gain to the target, capped to the editor's
 * volume range.
 */
export function levelGainFromBlocks(blocks: readonly number[]): { gain: number; measuredDb: number } | null {
  const audible = blocks.filter((power) => power > 1e-7).sort((a, b) => b - a);
  if (audible.length < 10) return null;
  const loud = audible.slice(0, Math.max(1, Math.round(audible.length * 0.6)));
  const meanPower = loud.reduce((sum, power) => sum + power, 0) / loud.length;
  const measuredDb = 10 * Math.log10(meanPower);
  const gain = Math.min(2, Math.max(0.25, 10 ** ((TARGET_SPEECH_DBFS - measuredDb) / 20)));
  return { gain, measuredDb };
}

// ---- Putting it together -------------------------------------------------------------------

export interface AutoEditOptions {
  cutPauses: boolean;
  fixFraming: boolean;
  punchIns: boolean;
  hookTitle: boolean;
  levelVolume: boolean;
  highlightKeywords: boolean;
}

export const DEFAULT_AUTO_EDIT_OPTIONS: AutoEditOptions = {
  cutPauses: true,
  fixFraming: true,
  punchIns: true,
  hookTitle: true,
  levelVolume: true,
  highlightKeywords: true,
};

export interface AutoEditInputs {
  duration: number;
  words: readonly WordCue[];
  socialTitle?: string;
  framing?: {
    aiShotBoundaries: readonly number[];
    faceSamples: readonly FaceBoxSample[];
    clipSegments: readonly ClipperClipSegmentWindow[];
    outputAspect: number;
  };
  levelGain?: number | null;
  /** The clip's caption lines as currently rendered, for keyword highlighting. */
  captionGroups?: readonly CaptionGroup[];
  /** Where to aim punch-ins (the speaker's face in the framed clip). */
  punchInCenter?: (start: number, end: number) => { x: number; y: number } | null;
}

export interface AutoEditSummary {
  removedSec: number;
  fillerCount: number;
  fixedShots: number;
  punchIns: number;
  hook: string | null;
  gainDb: number | null;
  keywords: number;
}

/** Applies the enabled auto-edit steps to an edit. Pure: the volume gain is measured beforehand. */
export function applyAutoEdit(
  edit: ClipEdit,
  inputs: AutoEditInputs,
  options: AutoEditOptions,
): { edit: ClipEdit; summary: AutoEditSummary } {
  const summary: AutoEditSummary = { removedSec: 0, fillerCount: 0, fixedShots: 0, punchIns: 0, hook: null, gainDb: null, keywords: 0 };
  let next: ClipEdit = { ...edit };

  if (options.cutPauses) {
    const plan = planPauseCuts(inputs.words, inputs.duration);
    if (plan && plan.segments.length > 0) {
      next = { ...next, segments: plan.segments };
      summary.removedSec = plan.removedSec;
      summary.fillerCount = plan.fillerCount;
    }
  }

  if (options.punchIns && next.segments.length > 1) {
    const punched = applyPunchIns(next.segments, PUNCH_IN_ZOOM, inputs.punchInCenter);
    next = { ...next, segments: punched.segments };
    summary.punchIns = punched.count;
  }

  if (options.fixFraming && next.framing && inputs.framing) {
    const plan = planFramingFixes(
      next.framing,
      inputs.framing.aiShotBoundaries,
      inputs.framing.faceSamples,
      inputs.framing.clipSegments,
      inputs.duration,
      inputs.framing.outputAspect,
    );
    next = { ...next, framing: plan.track };
    summary.fixedShots = plan.fixedShots.length;
  }

  if (options.hookTitle) {
    const hook = pickHookText(inputs.words, inputs.socialTitle);
    const outputDuration = next.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (hook && outputDuration > 1) {
      const overlay = {
        ...createTextOverlay(0, outputDuration),
        text: hook,
        end: Math.min(outputDuration, HOOK_DURATION_SEC),
        size: 0.055,
      };
      // Replace an earlier auto hook rather than stacking another one.
      const others = next.textOverlays.filter((item) => !item.id.startsWith("hook-"));
      next = { ...next, textOverlays: [{ ...overlay, id: createEditId("hook") }, ...others] };
      summary.hook = hook;
    }
  }

  if (options.highlightKeywords && inputs.captionGroups?.length) {
    const highlighted = highlightKeywords(inputs.captionGroups);
    if (highlighted.count > 0) {
      next = { ...next, captionGroups: highlighted.groups };
      summary.keywords = highlighted.count;
    }
  }

  if (options.levelVolume && inputs.levelGain && Number.isFinite(inputs.levelGain)) {
    next = { ...next, volume: Number(inputs.levelGain.toFixed(2)) };
    summary.gainDb = 20 * Math.log10(inputs.levelGain);
  }

  return { edit: next, summary };
}

export function describeAutoEdit(summary: AutoEditSummary): string {
  const parts: string[] = [];
  if (summary.removedSec > 0.05) {
    parts.push(
      `cut ${summary.removedSec.toFixed(1)}s of pauses${summary.fillerCount ? ` and ${summary.fillerCount} filler word${summary.fillerCount === 1 ? "" : "s"}` : ""}`,
    );
  }
  if (summary.fixedShots) parts.push(`split screen on ${summary.fixedShots} shot${summary.fixedShots === 1 ? "" : "s"}`);
  if (summary.punchIns) parts.push(`${summary.punchIns} punch-in${summary.punchIns === 1 ? "" : "s"}`);
  if (summary.hook) parts.push("a hook title");
  if (summary.keywords) parts.push(`${summary.keywords} highlighted keyword${summary.keywords === 1 ? "" : "s"}`);
  if (summary.gainDb !== null) {
    parts.push(Math.abs(summary.gainDb) < 0.5 ? "volume already level" : `volume ${summary.gainDb > 0 ? "+" : ""}${summary.gainDb.toFixed(1)} dB`);
  }
  return parts.length ? `Auto edit: ${parts.join(", ")}.` : "Auto edit didn't find anything to change.";
}
