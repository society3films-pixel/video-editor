import type { FaceSampleCache } from "../reframe/cache.util";
import { selectDominantFacePair } from "../reframe/collage/track.util";
import { faceToCentroid } from "../reframe/crop.util";
import type { CentroidSample } from "../types/reframe.types";
import type { FaceBoxSample } from "../../shared/face-samples.util";

/**
 * Face tracks for an AI-tracked forced split screen: the left and right person of the dominant
 * face pair over the whole range, each smoothed (see FOLLOW_TIME_CONSTANT_SEC). Times are range-source time
 * (the same clock as `FaceBoxSample.time` and the renderer's `t`).
 */
export interface SplitFaceTracks {
  left: CentroidSample[];
  right: CentroidSample[];
}

/** Gaps longer than this (no two faces detected) fall back to the panel's manual position. */
const MAX_TRACK_GAP_SEC = 2.5;
/**
 * Split panels are zoomed in (often a quarter of the frame wide), so they need tighter following
 * than the full-frame AI camera, whose stabiliser lets a face drift ~25% of the frame before it
 * moves. Here: a time-based ease (~0.4 s) with a tiny dead zone, reset at scene cuts.
 */
const FOLLOW_TIME_CONSTANT_SEC = 0.4;
const FOLLOW_DEAD_ZONE = 0.004;

interface Follower {
  value: { x: number; y: number; extent: number } | null;
  time: number;
}

function follow(state: Follower, observed: { x: number; y: number; extent: number }, time: number, cut: boolean) {
  if (!state.value || cut || time - state.time > MAX_TRACK_GAP_SEC) {
    state.value = observed;
  } else {
    const k = 1 - Math.exp(-Math.max(0, time - state.time) / FOLLOW_TIME_CONSTANT_SEC);
    const ease = (from: number, to: number) => (Math.abs(to - from) <= FOLLOW_DEAD_ZONE ? from : from + (to - from) * k);
    state.value = {
      x: ease(state.value.x, observed.x),
      y: ease(state.value.y, observed.y),
      extent: ease(state.value.extent, observed.extent),
    };
  }
  state.time = time;
  return state.value;
}

export function buildSplitFaceTracks(samples: readonly FaceBoxSample[]): SplitFaceTracks {
  const left: CentroidSample[] = [];
  const right: CentroidSample[] = [];
  const leftFollower: Follower = { value: null, time: 0 };
  const rightFollower: Follower = { value: null, time: 0 };
  for (const sample of samples) {
    if (sample.faces.length < 2 || sample.frameW <= 0 || sample.frameH <= 0) continue;
    const pair = selectDominantFacePair(sample.faces);
    if (!pair) continue;
    const cut = sample.sceneCut === true;
    const l = follow(leftFollower, faceToCentroid(pair.left, sample.frameW, sample.frameH), sample.time, cut);
    const r = follow(rightFollower, faceToCentroid(pair.right, sample.frameW, sample.frameH), sample.time, cut);
    left.push({ t: sample.time, ...l, cut });
    right.push({ t: sample.time, ...r, cut });
  }
  return { left, right };
}

/** The biggest face over time (the presenter in a screen recording), smoothed like the split tracks. */
export function buildLargestFaceTrack(samples: readonly FaceBoxSample[]): CentroidSample[] {
  const track: CentroidSample[] = [];
  const follower: Follower = { value: null, time: 0 };
  for (const sample of samples) {
    if (!sample.faces.length || sample.frameW <= 0 || sample.frameH <= 0) continue;
    const largest = sample.faces.reduce((best, face) => (face.width * face.height > best.width * best.height ? face : best));
    const cut = sample.sceneCut === true;
    track.push({ t: sample.time, ...follow(follower, faceToCentroid(largest, sample.frameW, sample.frameH), sample.time, cut), cut });
  }
  return track;
}

const largestCache = new WeakMap<FaceSampleCache, { revision: number; track: CentroidSample[] }>();

export function largestFaceTrackFor(faceCache: FaceSampleCache): CentroidSample[] {
  const revision = faceCache.sampleRevision;
  const cached = largestCache.get(faceCache);
  if (cached && cached.revision === revision) return cached.track;
  const track = buildLargestFaceTrack(faceCache.sortedSamples());
  largestCache.set(faceCache, { revision, track });
  return track;
}

const trackCache = new WeakMap<FaceSampleCache, { revision: number; tracks: SplitFaceTracks }>();

/** Tracks for a face cache, rebuilt only when its samples change. */
export function splitFaceTracksFor(faceCache: FaceSampleCache): SplitFaceTracks {
  const revision = faceCache.sampleRevision;
  const cached = trackCache.get(faceCache);
  if (cached && cached.revision === revision) return cached.tracks;
  const tracks = buildSplitFaceTracks(faceCache.sortedSamples());
  trackCache.set(faceCache, { revision, tracks });
  return tracks;
}

/**
 * Tracked face position at `t`: interpolated between samples, never blended across a scene cut,
 * holding the nearest sample through short gaps. Null when nothing is close enough.
 */
export function trackedPositionAt(
  samples: readonly CentroidSample[],
  t: number,
): { x: number; y: number; extent: number } | null {
  if (samples.length === 0) return null;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (samples[middle]!.t <= t) low = middle + 1;
    else high = middle;
  }
  const previous = samples[low - 1];
  const next = samples[low];
  if (previous && next && !next.cut && next.t - previous.t <= MAX_TRACK_GAP_SEC) {
    const u = (t - previous.t) / Math.max(1e-6, next.t - previous.t);
    return {
      x: previous.x + (next.x - previous.x) * u,
      y: previous.y + (next.y - previous.y) * u,
      extent: previous.extent + (next.extent - previous.extent) * u,
    };
  }
  const nearest = previous && t - previous.t <= MAX_TRACK_GAP_SEC ? previous : next && next.t - t <= MAX_TRACK_GAP_SEC ? next : null;
  return nearest ? { x: nearest.x, y: nearest.y, extent: nearest.extent } : null;
}
