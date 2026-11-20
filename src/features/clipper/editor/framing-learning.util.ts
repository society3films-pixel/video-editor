/**
 * Learns how the user fixes framing. Each saved clip's shots are classified (one person, two
 * people who don't fit one crop, a group, a screen recording) and the layout the user chose is
 * counted. Once a kind of shot has been fixed the same way 3+ times (70%+ of the time), Auto-fix
 * uses that layout for it.
 */
import type { FaceBoxSample } from "../shared/face-samples.util";
import type { ClipperClipSegmentWindow } from "../engine/segmentation/segmentation.types";
import { facesFitSingleCrop, selectDominantFacePair } from "../engine/reframe/collage/track.util";
import {
  defaultScreenPanels,
  defaultSplitPanels,
  isForcedSplit,
  shotIndexAt,
  type ClipFramingKeyframe,
  type ClipFramingTrack,
  type ClipperFramingValue,
} from "../engine/render/framing-override.util";
import { createEditId, framingShotBoundaries } from "./clip-edit.util";
import { looksLikeWebcamOverlay, planFramingFixes, rangeToLocal } from "./auto-edit.util";

export type ShotKind = "single" | "two" | "group" | "webcam";
export type LearnedLayout = "ai" | "one_shot" | "split" | "whole_frame" | "screen" | "slow_zoom";

export const SHOT_KIND_LABEL: Record<ShotKind, string> = {
  single: "one person",
  two: "two people who don't fit one shot",
  group: "three or more people",
  webcam: "screen recordings with a webcam",
};
export const LEARNED_LAYOUT_LABEL: Record<LearnedLayout, string> = {
  ai: "AI framing",
  one_shot: "one shot",
  split: "split screen",
  whole_frame: "whole frame",
  screen: "screen + face",
  slow_zoom: "slow zoom",
};

const STORAGE_KEY = "openclipper.framing.learned";
const MIN_CHOICES = 3;
const MIN_SHARE = 0.7;

type Counts = Partial<Record<ShotKind, Partial<Record<LearnedLayout, number>>>>;

function loadCounts(): Counts {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Counts;
  } catch {
    return {};
  }
}

function saveCounts(counts: Counts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch {
    // Storage unavailable: nothing is learned this time.
  }
}

export function forgetLearnedFraming(): void {
  saveCounts({});
}

/** Kind of each shot from the face samples in it. */
export function classifyShots(
  boundaries: readonly number[],
  faceSamples: readonly FaceBoxSample[],
  clipSegments: readonly ClipperClipSegmentWindow[],
  outputAspect: number,
): Map<number, ShotKind> {
  const stats = new Map<number, { n: number; webcam: number; group: number; two: number; dontFit: number; single: number }>();
  for (const sample of faceSamples) {
    const local = rangeToLocal(clipSegments, sample.time);
    if (local === null || !sample.faces.length) continue;
    const index = shotIndexAt(boundaries, local);
    const s = stats.get(index) ?? { n: 0, webcam: 0, group: 0, two: 0, dontFit: 0, single: 0 };
    s.n++;
    const largest = Math.max(...sample.faces.map((f) => f.width * f.height));
    const significant = sample.faces.filter((f) => f.width * f.height >= largest * 0.3).length;
    if (looksLikeWebcamOverlay(sample)) s.webcam++;
    else if (significant >= 3) s.group++;
    else if (significant === 2) {
      s.two++;
      const pair = selectDominantFacePair(sample.faces);
      if (pair && !facesFitSingleCrop(pair, sample.frameW, sample.frameH, outputAspect)) s.dontFit++;
    } else s.single++;
    stats.set(index, s);
  }
  const kinds = new Map<number, ShotKind>();
  for (const [index, s] of stats) {
    if (s.n < 3) continue;
    if (s.webcam / s.n >= 0.6) kinds.set(index, "webcam");
    else if (s.group / s.n >= 0.5) kinds.set(index, "group");
    else if (s.two / s.n >= 0.5 && s.dontFit / Math.max(1, s.two) >= 0.5) kinds.set(index, "two");
    else if (s.single / s.n >= 0.6) kinds.set(index, "single");
  }
  return kinds;
}

export function layoutOf(value: ClipperFramingValue | undefined): LearnedLayout {
  if (!value) return "ai";
  if (isForcedSplit(value)) return value.screen ? "screen" : "split";
  if (value.fit === "blur") return "whole_frame";
  if (value.slowZoom) return "slow_zoom";
  if (value.singleShot) return "one_shot";
  return "ai";
}

function valueFor(layout: LearnedLayout): ClipperFramingValue | null {
  const base: ClipperFramingValue = { mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false };
  switch (layout) {
    case "one_shot":
      return { ...base, singleShot: true };
    case "split":
      return { ...base, split: defaultSplitPanels(), splitFollow: true };
    case "screen":
      return { ...base, split: defaultScreenPanels(), screen: true };
    case "whole_frame":
      return { ...base, fit: "blur" };
    case "slow_zoom":
      return { ...base, slowZoom: 0.12 };
    default:
      return null;
  }
}

export interface LearnInputs {
  aiShotBoundaries: readonly number[];
  faceSamples: readonly FaceBoxSample[];
  clipSegments: readonly ClipperClipSegmentWindow[];
  outputAspect: number;
}

/** Counts the layouts the user chose for each kind of shot in a saved track. */
export function learnFromFraming(track: ClipFramingTrack, inputs: LearnInputs): void {
  const boundaries = framingShotBoundaries(track, inputs.aiShotBoundaries);
  const kinds = classifyShots(boundaries, inputs.faceSamples, inputs.clipSegments, inputs.outputAspect);
  const counts = loadCounts();
  let changed = false;
  for (const [shot, kind] of kinds) {
    const keyframe = track.keyframes.find((k) => shotIndexAt(boundaries, k.t) === shot);
    // Shots left on AI framing say nothing: the user may simply not have looked at them.
    if (!keyframe) continue;
    const layout = layoutOf(keyframe);
    const forKind = (counts[kind] ??= {});
    forKind[layout] = (forKind[layout] ?? 0) + 1;
    changed = true;
  }
  if (changed) saveCounts(counts);
}

/** The layout learned for each kind of shot (only confident ones). */
export function learnedLayouts(): Partial<Record<ShotKind, LearnedLayout>> {
  const result: Partial<Record<ShotKind, LearnedLayout>> = {};
  for (const [kind, layouts] of Object.entries(loadCounts()) as Array<[ShotKind, Partial<Record<LearnedLayout, number>>]>) {
    const entries = Object.entries(layouts ?? {}) as Array<[LearnedLayout, number]>;
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const [best, n] = entries.sort((a, b) => b[1] - a[1])[0] ?? [];
    if (best && n! >= MIN_CHOICES && n! / total >= MIN_SHARE) result[kind] = best;
  }
  return result;
}

/**
 * Auto-fix for a clip: the built-in fixes (split screen where two people don't fit, Screen + face
 * for screen recordings), with learned layouts taking over for the kinds of shot they cover.
 * Shots the user already framed are left alone.
 */
export function planFramingWithLearning(
  track: ClipFramingTrack,
  inputs: LearnInputs & { duration: number },
  learned: Partial<Record<ShotKind, LearnedLayout>> = learnedLayouts(),
): { track: ClipFramingTrack; fixedShots: number[] } {
  const boundaries = framingShotBoundaries(track, inputs.aiShotBoundaries);
  const kinds = classifyShots(boundaries, inputs.faceSamples, inputs.clipSegments, inputs.outputAspect);
  const keyframed = new Set(track.keyframes.map((k) => shotIndexAt(boundaries, k.t)));
  const added: ClipFramingKeyframe[] = [];
  const fixed: number[] = [];
  for (const [shot, kind] of kinds) {
    const layout = learned[kind];
    if (!layout || keyframed.has(shot)) continue;
    const value = valueFor(layout);
    keyframed.add(shot);
    fixed.push(shot);
    if (!value) continue;
    const start = shot === 0 ? 0 : boundaries[shot - 1]!;
    const end = shot < boundaries.length ? boundaries[shot]! : inputs.duration;
    added.push({ id: createEditId("kf"), t: (start + end) / 2, ...value });
  }
  const learnedTrack = added.length ? { ...track, keyframes: [...track.keyframes, ...added].sort((a, b) => a.t - b.t) } : track;
  // Built-in fixes for everything the learned layouts didn't cover.
  const builtIn = planFramingFixes(
    { ...learnedTrack, keyframes: [...learnedTrack.keyframes, ...[...keyframed].filter((s) => !added.some((k) => shotIndexAt(boundaries, k.t) === s)).map((s) => ({ id: "skip", t: s === 0 ? 0 : boundaries[s - 1]!, mode: "auto" as const, x: 0, y: 0, zoom: 1, singleShot: false }))] },
    inputs.aiShotBoundaries,
    inputs.faceSamples,
    inputs.clipSegments,
    inputs.duration,
    inputs.outputAspect,
  );
  const finalTrack = { ...builtIn.track, keyframes: builtIn.track.keyframes.filter((k) => k.id !== "skip") };
  return { track: finalTrack, fixedShots: [...new Set([...fixed, ...builtIn.fixedShots])].sort((a, b) => a - b) };
}
