/**
 * Finds shots where the automatic framing is probably wrong, so they can be reviewed instead of
 * watching every clip: faces cut by the crop edge, a person left out of frame, nobody in frame
 * although people are detected, and a shaky camera. Everything runs on the face tracking and
 * the same crop geometry the renderer uses; nothing is decoded.
 */
import type { FaceBox, FaceBoxSample } from "../shared/face-samples.util";
import { resolveClipperFrameGeometry } from "../engine/render/frame-geometry.util";
import { localTimeToSourceTime } from "../engine/segmentation/clip-time.util";
import { shotIndexAt, createEmptyFramingTrack } from "../engine/render/framing-override.util";
import type { ClipperCropRect } from "../engine/types/reframe.types";
import type { ClipEditorSource } from "./clip-editor-source.util";
import { framingShotBoundaries } from "./clip-edit.util";

export type FramingIssueKind = "face-cut" | "person-missing" | "nobody-in-frame" | "shaky";

export interface FramingIssue {
  kind: FramingIssueKind;
  shotIndex: number;
  /** Clip-local shot range. */
  start: number;
  end: number;
  /** Clip-local time where it's clearest, to jump to. */
  at: number;
  /** Share of the shot affected (0..1); for "shaky", how strong the shake is relative to the limit. */
  share: number;
  severity: "warning" | "info";
  message: string;
}

const STEP_SEC = 0.25;
const MAX_SAMPLE_GAP_SEC = 0.5;
/** Faces smaller than this share of the biggest one are background people; ignore them. */
const SIGNIFICANT_FACE_RATIO = 0.3;

function intersection(a: { x: number; y: number; width: number; height: number }, b: ClipperCropRect): number {
  const w = Math.min(a.x + a.width, b.sx + b.sw) - Math.max(a.x, b.sx);
  const h = Math.min(a.y + a.height, b.sy + b.sh) - Math.max(a.y, b.sy);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How much of a face (0..1) is inside any of the crops. */
export function faceCoverage(face: FaceBox, crops: readonly ClipperCropRect[]): number {
  const area = face.width * face.height;
  if (area <= 0) return 0;
  return Math.min(1, crops.reduce((max, crop) => Math.max(max, intersection(face, crop) / area), 0));
}

function significantFaces(faces: readonly FaceBox[]): FaceBox[] {
  const largest = faces.reduce((max, face) => Math.max(max, face.width * face.height), 0);
  return faces.filter((face) => face.width * face.height >= largest * SIGNIFICANT_FACE_RATIO);
}

function nearestSample(samples: readonly FaceBoxSample[], time: number): FaceBoxSample | null {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  let best: FaceBoxSample | null = null;
  for (const index of [lo - 1, lo]) {
    const sample = samples[index];
    if (sample && Math.abs(sample.time - time) <= MAX_SAMPLE_GAP_SEC && (!best || Math.abs(sample.time - time) < Math.abs(best.time - time))) best = sample;
  }
  return best;
}

export interface FrameObservation {
  t: number;
  faces: FaceBox[];
  crops: ClipperCropRect[];
  frameW: number;
  mode: "single-crop" | "split" | "contain";
}

interface ShotStats {
  samples: number;
  withFaces: number;
  cut: number;
  missing: number;
  nobody: number;
  worst: Record<"cut" | "missing" | "nobody", { t: number; score: number }>;
  centers: Array<{ t: number; x: number; width: number }>;
}

/** Pure part: turns per-moment observations into issues per shot. */
export function framingIssuesFromObservations(
  observations: readonly FrameObservation[],
  boundaries: readonly number[],
  duration: number,
): FramingIssue[] {
  const shots = new Map<number, ShotStats>();
  for (const obs of observations) {
    const index = shotIndexAt(boundaries, obs.t);
    let stats = shots.get(index);
    if (!stats) {
      stats = {
        samples: 0,
        withFaces: 0,
        cut: 0,
        missing: 0,
        nobody: 0,
        worst: { cut: { t: obs.t, score: -1 }, missing: { t: obs.t, score: -1 }, nobody: { t: obs.t, score: -1 } },
        centers: [],
      };
      shots.set(index, stats);
    }
    stats.samples++;
    if (obs.mode === "single-crop" && obs.crops[0]) {
      stats.centers.push({ t: obs.t, x: obs.crops[0].sx + obs.crops[0].sw / 2, width: obs.crops[0].sw });
    }
    const faces = significantFaces(obs.faces);
    if (!faces.length || obs.mode === "contain") continue;
    stats.withFaces++;
    const coverage = faces.map((face) => faceCoverage(face, obs.crops));
    const partial = coverage.filter((c) => c > 0.15 && c < 0.8);
    if (partial.length) {
      stats.cut++;
      const score = 1 - Math.min(...partial);
      if (score > stats.worst.cut.score) stats.worst.cut = { t: obs.t, score };
    }
    const inside = coverage.filter((c) => c >= 0.8).length;
    const outside = coverage.filter((c) => c <= 0.15).length;
    if (inside === 0 && outside === faces.length) {
      stats.nobody++;
      stats.worst.nobody = { t: obs.t, score: 1 };
    } else if (faces.length >= 2 && outside > 0 && obs.mode === "single-crop") {
      stats.missing++;
      if (stats.worst.missing.score < 0) stats.worst.missing = { t: obs.t, score: 1 };
    }
  }

  const issues: FramingIssue[] = [];
  const sorted = [0, ...boundaries.filter((b) => b > 0 && b < duration)];
  for (const [shotIndex, stats] of [...shots.entries()].sort((a, b) => a[0] - b[0])) {
    const start = sorted[shotIndex] ?? 0;
    const end = sorted[shotIndex + 1] ?? duration;
    const base = { shotIndex, start, end };
    const of = (count: number) => (stats.withFaces ? count / stats.withFaces : 0);
    // Short shots need a clearer signal; a single sample isn't a pattern.
    if (stats.withFaces >= 2) {
      if (of(stats.nobody) >= 0.25) {
        issues.push({ ...base, kind: "nobody-in-frame", at: stats.worst.nobody.t, share: of(stats.nobody), severity: "warning", message: `Nobody is in frame for ${Math.round(of(stats.nobody) * 100)}% of this shot, although people are visible in the video.` });
      }
      if (of(stats.cut) >= 0.3) {
        issues.push({ ...base, kind: "face-cut", at: stats.worst.cut.t, share: of(stats.cut), severity: "warning", message: `A face is cut by the edge of the frame for ${Math.round(of(stats.cut) * 100)}% of this shot.` });
      }
      if (of(stats.missing) >= 0.5) {
        issues.push({ ...base, kind: "person-missing", at: stats.worst.missing.t, share: of(stats.missing), severity: "info", message: `Someone is left out of frame for ${Math.round(of(stats.missing) * 100)}% of this shot. Fine if it's on purpose; otherwise try split screen.` });
      }
    }
    const shake = shakeAmount(stats.centers);
    if (shake > 1) {
      const worst = stats.centers[Math.floor(stats.centers.length / 2)]?.t ?? start;
      issues.push({ ...base, kind: "shaky", at: worst, share: shake, severity: shake > 2 ? "warning" : "info", message: "The camera moves back and forth a lot in this shot. Try locking it (Manual) or One shot." });
    }
  }
  return issues;
}

/**
 * Back-and-forth camera movement: the average change of direction of the crop centre, as a share
 * of the crop width per second. 1 = the limit where it starts to look restless.
 */
export function shakeAmount(centers: ReadonlyArray<{ t: number; x: number; width: number }>): number {
  if (centers.length < 6) return 0;
  let total = 0;
  for (let i = 2; i < centers.length; i++) {
    const a = centers[i - 2]!;
    const b = centers[i - 1]!;
    const c = centers[i]!;
    const v1 = b.x - a.x;
    const v2 = c.x - b.x;
    // Only reversals count; a smooth pan is fine.
    if (v1 * v2 < 0) total += Math.min(Math.abs(v1), Math.abs(v2)) / Math.max(1, b.width);
  }
  const seconds = Math.max(STEP_SEC, centers[centers.length - 1]!.t - centers[0]!.t);
  return total / seconds / 0.04;
}

/** Samples the clip and checks its framing as it would render. */
export function checkClipFraming(source: ClipEditorSource): FramingIssue[] {
  const faceCache = source.frameContext.faceCache;
  if (!faceCache) return [];
  const samples = faceCache.sortedSamples();
  const first = samples.find((sample) => sample.frameW > 0 && sample.frameH > 0);
  if (!first) return [];
  const videoSize = { width: first.frameW, height: first.frameH };
  const observations: FrameObservation[] = [];
  for (let t = 0; t < source.duration; t += STEP_SEC) {
    const rangeTime = localTimeToSourceTime(source.clip.segments, t);
    const geometry = resolveClipperFrameGeometry(source.formatDef, videoSize, source.outputSize, rangeTime, source.frameContext);
    const sample = nearestSample(samples, rangeTime);
    observations.push({
      t,
      faces: sample?.faces ?? [],
      crops: geometry.panels.map((panel) => panel.source),
      frameW: videoSize.width,
      mode: geometry.mode,
    });
  }
  const boundaries = framingShotBoundaries(source.framingTrack ?? createEmptyFramingTrack(), source.aiShotBoundaries);
  return framingIssuesFromObservations(observations, boundaries, source.duration);
}

export const FRAMING_ISSUE_LABEL: Record<FramingIssueKind, string> = {
  "face-cut": "Face cut off",
  "person-missing": "Person out of frame",
  "nobody-in-frame": "Nobody in frame",
  shaky: "Shaky camera",
};
