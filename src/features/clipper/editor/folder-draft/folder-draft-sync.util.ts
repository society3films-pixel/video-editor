/**
 * Lines a shoot's recordings up by sound, robustly:
 *  - each file is checked in several places (not one stretch), against every file already lined
 *    up; only an offset that several checks agree on is trusted;
 *  - the agreeing checks also measure clock drift (cameras and recorders run at slightly
 *    different speeds, a frame or two over 40 minutes);
 *  - embedded timecode, when files have it, narrows the search (and lines up files whose sound
 *    doesn't match, like B-roll cameras with timecode);
 *  - in the desktop app each match is then refined on 5 ms sound detail (sub-frame accuracy).
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../../shared/utils/platform.util";
import { correlatePeaks, refinePeak } from "../correlate.util";
import type { FolderMedia } from "./folder-draft.util";

/** Sync feature step: 20 ms level frames, two per step. */
export const SYNC_STEP_SEC = 0.04;
const WINDOW_SEC = 45;
const CLUSTER_SEC = 0.4;
const MAX_DRIFT = 3e-4;

/**
 * Sound "shape" for matching: log level per 40 ms with its 1 s local average removed, so
 * different microphones, gains and noise floors still match (only the ups and downs count).
 */
export function syncFeature(
  levels: Float32Array,
  framesPerStep = 2,
  smoothSteps = 25,
): Float32Array {
  const n = Math.floor(levels.length / framesPerStep);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < framesPerStep; j++)
      sum += levels[i * framesPerStep + j]!;
    energy[i] = Math.log(1e-4 + sum / framesPerStep);
  }
  const out = new Float32Array(n);
  const half = Math.floor(smoothSteps / 2);
  let running = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + half))
      ((running += energy[++hi]!), count++);
    while (lo < i - half) ((running -= energy[lo++]!), count--);
    out[i] = Math.max(-3, Math.min(3, energy[i]! - running / count));
  }
  return out;
}

function activity(feature: Float32Array): number {
  let sum = 0;
  for (const v of feature) sum += v * v;
  return Math.sqrt(sum / Math.max(1, feature.length));
}

/** Master time of a file time (offset + drift). */
export function masterTimeOf(
  media: Pick<FolderMedia, "offsetSec" | "drift">,
  fileTime: number,
): number {
  return media.offsetSec! + fileTime * (1 + (media.drift ?? 0));
}

/** File time of a master time. */
export function fileTimeOf(
  media: Pick<FolderMedia, "offsetSec" | "drift">,
  masterTime: number,
): number {
  return (masterTime - media.offsetSec!) / (1 + (media.drift ?? 0));
}

export interface SyncResult {
  offsetSec: number;
  drift: number;
  score: number;
  agreed: number;
  tried: number;
  method: "sound" | "timecode";
}

interface Check {
  window: number;
  itemCenter: number;
  masterCenter: number;
  score: number;
}

/** Where to check a file: up to five stretches spread through it, skipping near-silence. */
function windowsFor(feature: Float32Array): number[] {
  const length = Math.round(WINDOW_SEC / SYNC_STEP_SEC);
  if (feature.length < 150) return [];
  if (feature.length <= length * 1.5)
    return [
      Math.max(
        0,
        Math.floor((feature.length - Math.min(length, feature.length)) / 2),
      ),
    ];
  const starts: number[] = [];
  for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const start = Math.round((feature.length - length) * fraction);
    if (activity(feature.subarray(start, start + length)) > 0.15)
      starts.push(start);
  }
  return starts;
}

/**
 * Lines `item` up against the already lined-up `references` (their sync features). `prior` is
 * a timecode-based guess of the item's offset.
 */
export function syncItem(
  feature: Float32Array,
  references: ReadonlyArray<{ media: FolderMedia; feature: Float32Array }>,
  prior: number | null,
): SyncResult | null {
  const length = Math.round(WINDOW_SEC / SYNC_STEP_SEC);
  const windows = windowsFor(feature);
  const attempt = (around: number | null): SyncResult | null => {
    const checks: Check[] = [];
    windows.forEach((start, window) => {
      const slice = feature.subarray(
        start,
        Math.min(feature.length, start + length),
      );
      const itemCenter = (start + slice.length / 2) * SYNC_STEP_SEC;
      for (const reference of references) {
        let range: { minLag?: number; maxLag?: number } = {};
        if (around !== null) {
          // Expected lag in the reference from the guess, ±20 s.
          const refTime = fileTimeOf(
            reference.media,
            around + start * SYNC_STEP_SEC,
          );
          const lag = Math.round(refTime / SYNC_STEP_SEC);
          range = { minLag: lag - 500, maxLag: lag + 500 };
        }
        for (const peak of correlatePeaks(slice, reference.feature, {
          ...range,
          keep: 3,
          separation: 25,
        })) {
          if (peak.score < 0.12) continue;
          const refCenter = (peak.lag + slice.length / 2) * SYNC_STEP_SEC;
          checks.push({
            window,
            itemCenter,
            masterCenter: masterTimeOf(reference.media, refCenter),
            score: peak.score,
          });
        }
      }
    });
    // The offset most checks agree on (each window counts once, with its best score there).
    let best: { members: Check[]; weight: number } | null = null;
    for (const seed of checks) {
      const offset = seed.masterCenter - seed.itemCenter;
      const byWindow = new Map<number, Check>();
      for (const check of checks) {
        if (
          Math.abs(check.masterCenter - check.itemCenter - offset) > CLUSTER_SEC
        )
          continue;
        const current = byWindow.get(check.window);
        if (!current || check.score > current.score)
          byWindow.set(check.window, check);
      }
      const members = [...byWindow.values()];
      const weight = members.reduce((sum, c) => sum + c.score, 0);
      if (!best || weight > best.weight) best = { members, weight };
    }
    if (!best) return null;
    const agreed = best.members.length;
    const score = best.weight / agreed;
    const trusted =
      agreed >= 2
        ? score >= 0.2
        : windows.length <= 2
          ? score >= 0.4
          : score >= 0.55;
    if (!trusted) return null;
    // Fit master = offset + item * (1 + drift) through the agreeing checks.
    let drift = 0;
    const xs = best.members.map((c) => c.itemCenter);
    const ys = best.members.map((c) => c.masterCenter);
    const spread = Math.max(...xs) - Math.min(...xs);
    if (agreed >= 2 && spread >= 600) {
      const mx = xs.reduce((a, b) => a + b, 0) / agreed;
      const my = ys.reduce((a, b) => a + b, 0) / agreed;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < agreed; i++) {
        sxy += (xs[i]! - mx) * (ys[i]! - my);
        sxx += (xs[i]! - mx) ** 2;
      }
      const slope = sxx > 0 ? sxy / sxx : 1;
      drift = Math.abs(slope - 1) <= MAX_DRIFT ? slope - 1 : 0;
    }
    const offsets = best.members.map(
      (c) => c.masterCenter - c.itemCenter * (1 + drift),
    );
    const offsetSec = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    return {
      offsetSec,
      drift,
      score,
      agreed,
      tried: windows.length,
      method: "sound",
    };
  };
  if (!windows.length || !references.length)
    return prior !== null
      ? {
          offsetSec: prior,
          drift: 0,
          score: 0,
          agreed: 0,
          tried: 0,
          method: "timecode",
        }
      : null;
  const near = prior !== null ? attempt(prior) : null;
  if (near) return near;
  const anywhere = attempt(null);
  if (anywhere) return anywhere;
  // No sound match, but timecode: trust the timecode.
  return prior !== null
    ? {
        offsetSec: prior,
        drift: 0,
        score: 0,
        agreed: 0,
        tried: windows.length,
        method: "timecode",
      }
    : null;
}

// ---- Fine refinement (desktop app) --------------------------------------------------------------

const FINE_FRAME_MS = 5;

async function fineWindow(
  path: string,
  startSec: number,
  durationSec: number,
): Promise<{ startSec: number; feature: Float32Array } | null> {
  if (!isTauri()) return null;
  try {
    const result = await invoke<{ startSec: number; levels: number[] }>(
      "media_audio_levels_window",
      {
        path,
        startSec,
        durationSec,
        frameMs: FINE_FRAME_MS,
      },
    );
    // 5 ms steps, local average over 0.25 s.
    return {
      startSec: result.startSec,
      feature: syncFeature(Float32Array.from(result.levels), 1, 51),
    };
  } catch {
    return null;
  }
}

/**
 * Refines an item's offset against a reference on 5 ms detail: in a few places, searches
 * ±`searchSec` around where the current offset puts it. Returns the corrected offset (and how
 * many places agreed), or null when the detail didn't confirm anything.
 */
export async function refineOffset(
  item: FolderMedia,
  reference: FolderMedia,
  options: { searchSec?: number; places?: number } = {},
): Promise<{ offsetSec: number; agreed: number } | null> {
  if (
    item.offsetSec === null ||
    reference.offsetSec === null ||
    !item.hasAudio ||
    !reference.hasAudio
  )
    return null;
  const searchSec = options.searchSec ?? 0.15;
  const places = options.places ?? 3;
  const span = 12;
  // Places inside both recordings.
  const startMaster = Math.max(item.offsetSec, reference.offsetSec) + 5;
  const endMaster =
    Math.min(
      masterTimeOf(item, item.durationSec),
      masterTimeOf(reference, reference.durationSec),
    ) -
    span -
    5;
  if (endMaster <= startMaster) return null;
  const deltas: number[] = [];
  for (let k = 0; k < places; k++) {
    const master =
      startMaster + ((endMaster - startMaster) * (k + 0.5)) / places;
    const itemStart = fileTimeOf(item, master);
    const refStart = fileTimeOf(reference, master) - searchSec - 0.2;
    const [mine, theirs] = await Promise.all([
      fineWindow(item.path, itemStart, span),
      fineWindow(reference.path, refStart, span + 2 * (searchSec + 0.2)),
    ]);
    if (
      !mine ||
      !theirs ||
      mine.feature.length < 200 ||
      activity(mine.feature) < 0.1
    )
      continue;
    const step = FINE_FRAME_MS / 1000;
    // Where the item window's start should be in the reference window, by the current offset.
    const expected =
      (fileTimeOf(reference, masterTimeOf(item, mine.startSec)) -
        theirs.startSec) /
      step;
    const radius = Math.round(searchSec / step);
    const peak = correlatePeaks(mine.feature, theirs.feature, {
      minLag: Math.round(expected) - radius,
      maxLag: Math.round(expected) + radius,
    })[0];
    if (!peak || peak.score < 0.3) continue;
    const exact = refinePeak(mine.feature, theirs.feature, peak.lag);
    // The reference hears it (exact - expected) steps later than predicted: the item sits later on the master clock.
    deltas.push((exact - expected) * step * (1 + (reference.drift ?? 0)));
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)]!;
  const agreeing = deltas.filter((d) => Math.abs(d - median) < 0.02);
  if (deltas.length >= 2 && agreeing.length < 2) return null;
  const delta = agreeing.reduce((a, b) => a + b, 0) / agreeing.length;
  return { offsetSec: item.offsetSec + delta, agreed: agreeing.length };
}

/** Timecode of each file's start (seconds since midnight), when files carry it. */
export async function readTimecode(path: string): Promise<number | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<number | null>("media_timecode", { path });
  } catch {
    return null;
  }
}
