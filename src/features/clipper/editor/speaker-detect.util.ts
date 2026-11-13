/** Measures mouth movement of the two tracked people (see engine/render/speaker-emphasis.util). */
import { VideoSampleSink } from "mediabunny";
import type { WordCue } from "../lib/media/transcription-export.util";
import type { FaceBox, FaceBoxSample } from "../shared/face-samples.util";
import type { ClipperClipSegmentWindow } from "../engine/segmentation/segmentation.types";
import { selectDominantFacePair } from "../engine/reframe/collage/track.util";
import { localTimeToSourceTime } from "../engine/segmentation/clip-time.util";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import {
  speakerSpansFromActivity,
  type MouthActivitySample,
  type SpeakerSpan,
} from "../engine/render/speaker-emphasis.util";

const SAMPLE_STEP_SEC = 0.1;
const PATCH_W = 24;
const PATCH_H = 14;
/** Use a face sample this close to the frame; otherwise the person is unknown here. */
const MAX_FACE_SAMPLE_GAP_SEC = 0.6;

type PickFaces = (faces: FaceBox[]) => { left: FaceBox; right: FaceBox } | null;

function nearestPair(samples: readonly FaceBoxSample[], time: number, pick: PickFaces = selectDominantFacePair) {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  for (const index of [lo, lo - 1]) {
    const sample = samples[index];
    if (!sample || Math.abs(sample.time - time) > MAX_FACE_SAMPLE_GAP_SEC || sample.faces.length < (pick === selectDominantFacePair ? 2 : 1)) continue;
    const pair = pick(sample.faces);
    if (pair) return { pair, frameW: sample.frameW, frameH: sample.frameH };
  }
  return null;
}

/** Lower part of the face (mouth and chin), in the face detector's pixel space. */
function mouthRect(face: FaceBox) {
  return { x: face.x + face.width * 0.2, y: face.y + face.height * 0.58, width: face.width * 0.6, height: face.height * 0.42 };
}

function patchDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ga = a[i]! * 0.299 + a[i + 1]! * 0.587 + a[i + 2]! * 0.114;
    const gb = b[i]! * 0.299 + b[i + 1]! * 0.587 + b[i + 2]! * 0.114;
    sum += Math.abs(ga - gb);
  }
  return sum / (a.length / 4);
}

/**
 * Samples the range video every 0.1 s inside the clip and measures how much each person's mouth
 * area changed since the previous sample. `file` is the range video (range-source time, the same
 * clock as the face samples); results are in clip-local time.
 */
export async function measureMouthActivity(
  file: File,
  faceSamples: readonly FaceBoxSample[],
  clipSegments: ClipperClipSegmentWindow[],
  duration: number,
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void; pickFaces?: PickFaces } = {},
): Promise<MouthActivitySample[]> {
  const input = await createMediabunnyInput(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error("This video can't be decoded here.");
    const sink = new VideoSampleSink(track);
    const localTimes: number[] = [];
    for (let t = 0; t < duration; t += SAMPLE_STEP_SEC) localTimes.push(t);
    const canvas = new OffscreenCanvas(PATCH_W * 2, PATCH_H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create a canvas.");

    const results: MouthActivitySample[] = [];
    let previous: { t: number; left: Uint8ClampedArray; right: Uint8ClampedArray } | null = null;
    let index = 0;
    for await (const sample of sink.samplesAtTimestamps(localTimes.map((t) => localTimeToSourceTime(clipSegments, t)))) {
      const localT = localTimes[index++]!;
      if (options.signal?.aborted) {
        sample?.close();
        throw new DOMException("Aborted", "AbortError");
      }
      if (!sample) continue;
      try {
        const faces = nearestPair(faceSamples, localTimeToSourceTime(clipSegments, localT), options.pickFaces);
        if (!faces) {
          previous = null;
          continue;
        }
        const scaleX = sample.displayWidth / Math.max(1, faces.frameW);
        const scaleY = sample.displayHeight / Math.max(1, faces.frameH);
        [faces.pair.left, faces.pair.right].forEach((face, side) => {
          const rect = mouthRect(face);
          sample.draw(ctx, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY, side * PATCH_W, 0, PATCH_W, PATCH_H);
        });
        const left = ctx.getImageData(0, 0, PATCH_W, PATCH_H).data;
        const right = ctx.getImageData(PATCH_W, 0, PATCH_W, PATCH_H).data;
        if (previous && localT - previous.t < SAMPLE_STEP_SEC * 2.5) {
          results.push({ t: localT, left: patchDifference(previous.left, left), right: patchDifference(previous.right, right) });
        }
        previous = { t: localT, left, right };
      } finally {
        sample.close();
      }
      options.onProgress?.(index / localTimes.length);
    }
    return results;
  } finally {
    input.dispose();
  }
}

/**
 * Mouth movement of the biggest face (the on-screen person) every 0.1 s, clip-local. Words said
 * while it stays still are probably from someone off camera (the interviewer).
 */
export async function measureMainMouthActivity(
  file: File,
  faceSamples: readonly FaceBoxSample[],
  clipSegments: ClipperClipSegmentWindow[],
  duration: number,
  options: { signal?: AbortSignal } = {},
): Promise<Array<{ t: number; activity: number }>> {
  // The two-person measurement with the biggest face in both slots.
  const biggest: PickFaces = (faces) => {
    if (!faces.length) return null;
    const face = faces.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    return { left: face, right: face };
  };
  const activity = await measureMouthActivity(file, faceSamples, clipSegments, duration, { ...options, pickFaces: biggest });
  return activity.map((sample) => ({ t: sample.t, activity: (sample.left + sample.right) / 2 }));
}

export async function detectSpeakers(
  file: File,
  faceSamples: readonly FaceBoxSample[],
  clipSegments: ClipperClipSegmentWindow[],
  words: readonly WordCue[],
  duration: number,
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void } = {},
): Promise<SpeakerSpan[]> {
  const activity = await measureMouthActivity(file, faceSamples, clipSegments, duration, options);
  return speakerSpansFromActivity(activity, words, duration);
}
