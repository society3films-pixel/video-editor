/** Measures a clip's colour from a few frames of the source, for the automatic correction. */
import { VideoSampleSink } from "mediabunny";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import { localTimeToSourceTime } from "../engine/segmentation/clip-time.util";
import { measureColorCorrection, type ColorCorrection } from "../engine/render/color-grade.util";
import type { ClipEditorSource } from "./clip-editor-source.util";

const FRAMES = 8;

export async function measureClipColor(source: Pick<ClipEditorSource, "rangeFile" | "clip" | "duration">): Promise<ColorCorrection | null> {
  const input = await createMediabunnyInput(source.rangeFile);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const times = Array.from({ length: FRAMES }, (_, i) => localTimeToSourceTime(source.clip.segments, ((i + 0.5) / FRAMES) * source.duration));
    const canvas = new OffscreenCanvas(96, 54);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const frames: Uint8ClampedArray[] = [];
    for await (const sample of new VideoSampleSink(track).samplesAtTimestamps(times)) {
      if (!sample) continue;
      try {
        sample.draw(ctx, 0, 0, canvas.width, canvas.height);
        frames.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      } finally {
        sample.close();
      }
    }
    return measureColorCorrection(frames);
  } finally {
    input.dispose();
  }
}
