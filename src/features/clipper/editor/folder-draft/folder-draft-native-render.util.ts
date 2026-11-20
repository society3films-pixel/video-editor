/** Native (FFmpeg) render of a draft timeline: the desktop app's fast path. */
import { invoke } from "@tauri-apps/api/core";
import type { DraftTimeline, TimelineClip } from "./folder-draft.util";
import { captionImage, type DraftCaption } from "./folder-draft-render.util";

const clip = (c: TimelineClip) => ({
  path: c.media.path,
  inSec: c.inSec,
  outSec: c.outSec,
  startSec: c.startSec,
});

export async function renderDraftNative(
  timeline: DraftTimeline,
  options: {
    width: number;
    height: number;
    fps: number;
    maxHeight?: number;
    captions?: readonly DraftCaption[];
    projectId: string;
    fileName: string;
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<{ filePath: string; encoder: string }> {
  const scale =
    options.maxHeight && options.height > options.maxHeight
      ? options.maxHeight / options.height
      : 1;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const width = even(options.width * scale);
  const height = even(options.height * scale);
  const captions = [];
  for (const [index, caption] of (options.captions ?? []).entries()) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const image = await captionImage(caption.text, width, height);
    if (image)
      captions.push({ start: caption.start, end: caption.end, ...image });
    if (index % 25 === 0)
      options.onProgress?.(
        0.01 * (index / Math.max(1, options.captions!.length)),
      );
  }
  const spec = {
    width,
    height,
    fps: Math.min(60, Math.max(12, options.fps || 30)),
    durationSec: timeline.durationSec,
    video: timeline.video.map(clip),
    broll: timeline.broll.map(clip),
    audio: timeline.audio.map(clip),
    captions,
  };
  const poll = setInterval(() => {
    void invoke<number>("draft_render_progress")
      .then((ratio) => options.onProgress?.(0.01 + ratio * 0.99))
      .catch(() => {});
  }, 500);
  const onAbort = () => void invoke("cancel_draft_render").catch(() => {});
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await invoke<{ filePath: string; encoder: string }>(
      "render_draft_native",
      {
        projectId: options.projectId,
        fileName: options.fileName,
        spec,
      },
    );
  } catch (error) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearInterval(poll);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
