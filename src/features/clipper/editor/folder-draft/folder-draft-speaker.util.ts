/**
 * Who's talking, per camera: the desktop app's face detector finds each camera's main face during
 * the draft's talking parts, and the mouth area's movement is measured every 0.1 s. The draft then
 * cuts to the camera whose person is talking (see planShots).
 */
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
  const jobs = draft.story.parts.flatMap((part) => {
    if (part.kind !== "talk") return [];
    const cameras = camerasForPart(draft.items, part);
    if (cameras.length < 2) return [];
    return cameras
      .filter((camera) => !covered(camera.path, part.startSec, part.endSec))
      .map((camera) => ({ camera, a: part.startSec, b: part.endSec }));
  });
  if (!jobs.length) return activity;
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
