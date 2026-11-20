/**
 * Who's talking, per camera: the desktop app's face detector finds each camera's main face during
 * the draft's talking parts, and the mouth area's movement is measured every 0.1 s. The draft then
 * cuts to the camera whose person is talking (see planShots).
 */
import { unloadLocalModels } from "../ai-editor/ai-editor-local.util";
import { FaceSampleCache } from "../../engine/reframe/cache.util";
import { prefillFaceSampleCache } from "../../engine/reframe/analysis.util";
import { measureMainMouthActivity } from "../speaker-detect.util";
import { fileTimeOf, masterTimeOf } from "./folder-draft-sync.util";
import {
  camerasForPart,
  fileFor,
  type CameraActivity,
} from "./folder-draft.util";
import type { FolderDraft } from "./folder-draft-run.util";

const BIN_SEC = 0.5;

export async function analyzeDraftSpeakers(
  draft: FolderDraft,
  options: {
    onProgress?: (step: string, ratio: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<CameraActivity> {
  const activity: CameraActivity = { ...(draft.activity ?? {}) };
  const covered = (path: string, a: number, b: number) =>
    (activity[path] ?? []).some(
      (run) =>
        run.start <= a + 0.25 &&
        run.start + run.values.length * run.step >= b - 0.25,
    );
  const partJobs = draft.story.parts.flatMap((part) => {
    if (part.kind !== "talk") return [];
    const cameras = camerasForPart(draft.items, part);
    if (cameras.length < 2) return [];
    return cameras
      .filter((camera) => !covered(camera.path, part.startSec, part.endSec))
      .map((camera) => ({ camera, a: part.startSec, b: part.endSec }));
  });
  const jobs = mergeNearbyJobs(partJobs);
  if (!jobs.length) return activity;
  // Face detection runs on the graphics card: free it from a local AI model first.
  await unloadLocalModels();
  for (const [index, { camera, a, b }] of jobs.entries()) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const ratio = index / jobs.length;
    options.onProgress?.(
      `Watching ${camera.name} (${index + 1} of ${jobs.length})`,
      ratio,
    );
    const fileStart = Math.max(0, fileTimeOf(camera, a));
    const fileEnd = Math.min(camera.durationSec, fileTimeOf(camera, b));
    if (fileEnd - fileStart < 1) continue;
    const file = fileFor(camera);
    const cache = new FaceSampleCache();
    await prefillFaceSampleCache(file, cache, {
      signal: options.signal,
      nativeSource: {
        filePath: camera.path,
        startTime: fileStart,
        endTime: fileEnd,
      },
      onProgress: (r) =>
        options.onProgress?.(
          `Finding faces in ${camera.name}`,
          ratio + (r * 0.5) / jobs.length,
        ),
    });
    const mouth = await measureMainMouthActivity(
      file,
      cache.sortedSamples(),
      [{ startSec: fileStart, endSec: fileEnd }],
      fileEnd - fileStart,
      {
        signal: options.signal,
      },
    );
    const values = new Array<number>(
      Math.ceil((fileEnd - fileStart) / BIN_SEC),
    ).fill(0);
    const counts = new Array<number>(values.length).fill(0);
    for (const sample of mouth) {
      const k = Math.min(values.length - 1, Math.floor(sample.t / BIN_SEC));
      values[k]! += sample.activity;
      counts[k]!++;
    }
    for (let k = 0; k < values.length; k++)
      values[k] = counts[k] ? Number((values[k]! / counts[k]!).toFixed(2)) : 0;
    (activity[camera.path] ??= []).push({
      start: masterTimeOf(camera, fileStart),
      step: BIN_SEC,
      values,
    });
  }
  options.onProgress?.("Done", 1);
  return activity;
}

/**
 * Parts close together on the same camera are analysed as one stretch: starting the face detector
 * costs a few seconds each time, and an hour-long shoot can have dozens of parts.
 */
export function mergeNearbyJobs<
  T extends { camera: { path: string }; a: number; b: number },
>(jobs: readonly T[], gapSec = 45, maxSec = 480): T[] {
  const merged: T[] = [];
  const byCamera = new Map<string, T[]>();
  for (const job of jobs)
    byCamera.set(job.camera.path, [
      ...(byCamera.get(job.camera.path) ?? []),
      job,
    ]);
  for (const list of byCamera.values()) {
    const sorted = [...list].sort((x, y) => x.a - y.a);
    let current: T | null = null;
    for (const job of sorted) {
      if (
        current &&
        job.a - current.b <= gapSec &&
        Math.max(current.b, job.b) - current.a <= maxSec
      ) {
        current = Object.assign({}, current, {
          b: Math.max(current.b, job.b),
        }) as T;
      } else {
        if (current) merged.push(current);
        current = Object.assign({}, job) as T;
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}
