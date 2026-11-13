/**
 * Multicam: extra camera angles (a second interview camera, performance cameras) lined up with
 * the main camera by their sound, then used for chosen parts or automatically during songs.
 */
import { VideoSampleSink, type VideoSample } from "mediabunny";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import { localTimeToSourceTime } from "../engine/segmentation/clip-time.util";
import type { ClipperClipSegmentWindow } from "../engine/segmentation/segmentation.types";
import { frameLevels, inMusicSection } from "./music-detect.util";
import type { ClipEdit, ClipEditSegment } from "./clip-edit.util";
import { loadEditorAsset } from "./editor-assets.util";
import { correlatePeaks } from "./correlate.util";

export interface ClipAngle {
  id: string;
  assetId: string;
  name: string;
  /** Angle file time = main range time + offset. */
  offsetSec: number;
  /** 0..1: how sure the sound match was. */
  confidence: number;
  /** Crop of the angle for the output shape: horizontal centre 0..1, zoom ≥ 1. */
  x: number;
  y: number;
  zoom: number;
}

/** Level frames are 20 ms; the envelope groups two of them (25 Hz). */
const LEVEL_FRAME_SEC = 0.02;
const ENVELOPE_FRAMES = 2;
const ENVELOPE_SEC = LEVEL_FRAME_SEC * ENVELOPE_FRAMES;

/** Log-energy envelope at 25 Hz from 20 ms frame levels, mean removed. */
export function envelopeFromLevels(levels: Float32Array): Float32Array {
  const step = ENVELOPE_FRAMES;
  const out = new Float32Array(Math.floor(levels.length / step));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += levels[i * step + j]!;
    out[i] = Math.log(1e-4 + sum / step);
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= Math.max(1, out.length);
  for (let i = 0; i < out.length; i++) out[i]! -= mean;
  return out;
}

/**
 * Best lag (in envelope steps) of `reference` inside `target`: target[i + lag] ≈ reference[i].
 * Normalised cross-correlation over every lag (FFT); returns the lag and its correlation.
 */
export function bestLag(reference: Float32Array, target: Float32Array): { lag: number; score: number } {
  return correlatePeaks(reference, target)[0] ?? { lag: 0, score: -Infinity };
}

/**
 * Lines an angle up with the main camera: up to two minutes of the main camera's sound from the
 * clip's start, searched across the whole angle recording.
 */
export async function syncAngle(
  angleFile: File,
  mainRangeFile: File,
  clipSegments: ClipperClipSegmentWindow[],
  signal?: AbortSignal,
): Promise<{ offsetSec: number; confidence: number }> {
  const [mainLevels, angleLevels] = await Promise.all([frameLevels(mainRangeFile, signal), frameLevels(angleFile, signal)]);
  const mainEnvelope = envelopeFromLevels(mainLevels);
  const angleEnvelope = envelopeFromLevels(angleLevels);
  const startSec = localTimeToSourceTime(clipSegments, 0);
  const from = Math.floor(startSec / ENVELOPE_SEC);
  const length = Math.min(Math.round(120 / ENVELOPE_SEC), mainEnvelope.length - from);
  if (length < 100) throw new Error("The clip is too short to line up the angle by sound.");
  const reference = mainEnvelope.slice(from, from + length);
  const { lag, score } = bestLag(reference, angleEnvelope);
  // reference starts at `startSec` in main range time and at (lag) steps in the angle.
  const offsetSec = lag * ENVELOPE_SEC - startSec;
  return { offsetSec, confidence: Math.max(0, Math.min(1, score)) };
}

/** The angle shown at clip-local time `t` in part `segment`, or null for the main camera. */
export function angleAt(edit: Pick<ClipEdit, "angles" | "angleForSongs" | "musicSections">, segment: ClipEditSegment | undefined, t: number): ClipAngle | null {
  const angles = edit.angles ?? [];
  if (!angles.length) return null;
  if (segment?.angle) return angles.find((a) => a.id === segment.angle) ?? null;
  if (edit.angleForSongs && inMusicSection(edit.musicSections ?? undefined, t)) return angles.find((a) => a.id === edit.angleForSongs) ?? null;
  return null;
}

/** Crop of an angle frame for an output shape (cover, centred on the angle's x/y, zoomed). */
export function angleCrop(angle: Pick<ClipAngle, "x" | "y" | "zoom">, width: number, height: number, outWidth: number, outHeight: number) {
  const aspect = outWidth / outHeight;
  let sw = width;
  let sh = width / aspect;
  if (sh > height) {
    sh = height;
    sw = height * aspect;
  }
  const zoom = Math.max(1, angle.zoom || 1);
  sw /= zoom;
  sh /= zoom;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { sx: clamp(angle.x * width - sw / 2, 0, width - sw), sy: clamp(angle.y * height - sh / 2, 0, height - sh), sw, sh };
}

/** Reads angle recordings front to back during a render (one reader per angle). */
export async function loadAngleReaders(angles: readonly ClipAngle[]) {
  const readers = new Map<
    string,
    { input: Awaited<ReturnType<typeof createMediabunnyInput>>; iterator: AsyncIterator<VideoSample>; current: VideoSample | null; upcoming: VideoSample | null; done: boolean; startedAt: number }
  >();
  for (const angle of angles) {
    const file = await loadEditorAsset(angle.assetId);
    if (!file) throw new Error(`The angle "${angle.name}" is no longer saved on this computer. Add it again.`);
    const input = await createMediabunnyInput(file);
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      throw new Error(`"${angle.name}" can't be decoded here.`);
    }
    readers.set(angle.id, { input, iterator: new VideoSampleSink(track).samples()[Symbol.asyncIterator](), current: null, upcoming: null, done: false, startedAt: -1 });
  }
  return {
    /** Frame of `angle` at angle-file time `t` (times must mostly increase; a jump back restarts). */
    async frameAt(angle: ClipAngle, t: number): Promise<VideoSample | null> {
      const reader = readers.get(angle.id);
      if (!reader) return null;
      if (reader.current && t < reader.current.timestamp - 0.5) {
        // Jumped backwards (a cut to an earlier moment): restart from a seek.
        reader.current.close();
        reader.upcoming?.close();
        void reader.iterator.return?.();
        const track = (await reader.input.getPrimaryVideoTrack())!;
        reader.iterator = new VideoSampleSink(track).samples(Math.max(0, t - 0.1))[Symbol.asyncIterator]();
        reader.current = null;
        reader.upcoming = null;
        reader.done = false;
      } else if (!reader.current && reader.startedAt < 0 && t > 2) {
        const track = (await reader.input.getPrimaryVideoTrack())!;
        reader.iterator = new VideoSampleSink(track).samples(Math.max(0, t - 0.1))[Symbol.asyncIterator]();
      }
      reader.startedAt = t;
      for (;;) {
        if (!reader.upcoming && !reader.done) {
          const next = await reader.iterator.next();
          if (next.done) reader.done = true;
          else reader.upcoming = next.value;
        }
        if (!reader.upcoming || reader.upcoming.timestamp > t) break;
        reader.current?.close();
        reader.current = reader.upcoming;
        reader.upcoming = null;
      }
      return reader.current;
    },
    dispose() {
      for (const reader of readers.values()) {
        reader.current?.close();
        reader.upcoming?.close();
        void reader.iterator.return?.();
        reader.input.dispose();
      }
    },
  };
}

/** Angle-file time for clip-local `t`. */
export function angleTime(angle: ClipAngle, clipSegments: ClipperClipSegmentWindow[], t: number): number {
  return localTimeToSourceTime(clipSegments, t) + angle.offsetSec;
}
