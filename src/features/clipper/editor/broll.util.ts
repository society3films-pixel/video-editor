/**
 * B-roll: an image or video shown over part of the edit. Captions are already burned into the
 * clip, so the default layout covers the top part and leaves them visible.
 */
import { VideoSampleSink, type VideoSample } from "mediabunny";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import { loadEditorAsset } from "./editor-assets.util";

export type ClipInsertLayout = "top" | "full" | "pip";

export interface ClipInsert {
  id: string;
  assetId: string;
  name: string;
  kind: "image" | "video";
  /** Main-edit output time (like text overlays). */
  start: number;
  end: number;
  layout: ClipInsertLayout;
}

export const INSERT_LAYOUT_LABEL: Record<ClipInsertLayout, string> = {
  top: "Top part (keeps captions)",
  full: "Full screen",
  pip: "Picture in picture",
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Where an insert goes on a frame of `width` × `height`. */
export function insertRect(layout: ClipInsertLayout, width: number, height: number) {
  if (layout === "full") return { x: 0, y: 0, width, height, radius: 0 };
  if (layout === "top") return { x: 0, y: 0, width, height: Math.round(height * (width < height ? 0.58 : 0.62)), radius: 0 };
  const boxWidth = Math.round(width * (width < height ? 0.5 : 0.34));
  const boxHeight = Math.round(boxWidth * (width < height ? 1 : 9 / 16));
  const margin = Math.round(width * 0.04);
  return { x: width - boxWidth - margin, y: Math.round(height * 0.08), width: boxWidth, height: boxHeight, radius: Math.round(boxWidth * 0.06) };
}

/** Draws media to cover its rect (cropping what spills over), with a short fade in and out. */
export function drawInsert(
  ctx: Ctx2D,
  media: CanvasImageSource,
  mediaWidth: number,
  mediaHeight: number,
  insert: ClipInsert,
  insertTime: number,
  width: number,
  height: number,
): void {
  const rect = insertRect(insert.layout, width, height);
  const scale = Math.max(rect.width / mediaWidth, rect.height / mediaHeight);
  const sw = rect.width / scale;
  const sh = rect.height / scale;
  const fade = Math.min(1, insertTime / 0.15, (insert.end - insert.start - insertTime) / 0.15);
  ctx.save();
  ctx.globalAlpha *= Math.max(0, fade);
  if (rect.radius) {
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = rect.radius * 2;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.beginPath();
    const border = Math.max(2, Math.round(rect.width * 0.012));
    ctx.roundRect(rect.x + border, rect.y + border, rect.width - border * 2, rect.height - border * 2, Math.max(0, rect.radius - border));
    ctx.clip();
  }
  ctx.drawImage(media, (mediaWidth - sw) / 2, (mediaHeight - sh) / 2, sw, sh, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

export function activeInserts(inserts: readonly ClipInsert[] | undefined, time: number): ClipInsert[] {
  return (inserts ?? []).filter((insert) => time >= insert.start && time < insert.end);
}

// ---- Render-time media -------------------------------------------------------------------------

interface LoadedMedia {
  /** Current frame for the insert's own time; for video, advance() first. */
  frame: () => { media: CanvasImageSource; width: number; height: number } | null;
  advance: (insertTime: number) => Promise<void>;
  dispose: () => void;
}

async function loadImage(file: File): Promise<LoadedMedia> {
  const bitmap = await createImageBitmap(file);
  return { frame: () => ({ media: bitmap, width: bitmap.width, height: bitmap.height }), advance: async () => {}, dispose: () => bitmap.close() };
}

/** Reads a video insert front to back, keeping the frame for the time last asked. */
async function loadVideo(file: File): Promise<LoadedMedia> {
  const input = await createMediabunnyInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) {
    input.dispose();
    throw new Error(`"${file.name}" can't be decoded here.`);
  }
  const iterator = new VideoSampleSink(track).samples()[Symbol.asyncIterator]();
  let current: VideoSample | null = null;
  let upcoming: VideoSample | null = null;
  let done = false;
  return {
    frame: () => (current ? { media: current.toCanvasImageSource(), width: current.displayWidth, height: current.displayHeight } : null),
    async advance(insertTime) {
      for (;;) {
        if (!upcoming && !done) {
          const next = await iterator.next();
          if (next.done) done = true;
          else upcoming = next.value;
        }
        // Past the end of the video: hold its last frame.
        if (!upcoming || upcoming.timestamp > insertTime) break;
        current?.close();
        current = upcoming;
        upcoming = null;
      }
    },
    dispose() {
      current?.close();
      upcoming?.close();
      void iterator.return?.();
      input.dispose();
    },
  };
}

/** Loads every insert's media for a render; `frameFor` must be called in time order per insert. */
export async function loadInsertMedia(inserts: readonly ClipInsert[]) {
  const loaded = new Map<string, LoadedMedia>();
  try {
    for (const insert of inserts) {
      const file = await loadEditorAsset(insert.assetId);
      if (!file) throw new Error(`The B-roll file "${insert.name}" is no longer saved on this computer. Add it again.`);
      loaded.set(insert.id, insert.kind === "image" ? await loadImage(file) : await loadVideo(file));
    }
  } catch (error) {
    for (const media of loaded.values()) media.dispose();
    throw error;
  }
  return {
    async frameFor(insert: ClipInsert, insertTime: number) {
      const media = loaded.get(insert.id);
      if (!media) return null;
      await media.advance(insertTime);
      return media.frame();
    },
    dispose() {
      for (const media of loaded.values()) media.dispose();
    },
  };
}

// ---- Editor preview ----------------------------------------------------------------------------

type PreviewEntry =
  | { state: "loading" }
  | { state: "image"; bitmap: ImageBitmap }
  | { state: "video"; video: HTMLVideoElement; url: string }
  | { state: "error" };

const previewCache = new Map<string, PreviewEntry>();

function startPreviewLoad(insert: ClipInsert, onReady: () => void): void {
  previewCache.set(insert.assetId, { state: "loading" });
  void loadEditorAsset(insert.assetId)
    .then(async (file) => {
      if (!file) throw new Error("missing");
      if (insert.kind === "image") {
        previewCache.set(insert.assetId, { state: "image", bitmap: await createImageBitmap(file) });
      } else {
        const url = URL.createObjectURL(file);
        const video = document.createElement("video");
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        previewCache.set(insert.assetId, { state: "video", video, url });
      }
      onReady();
    })
    .catch(() => previewCache.set(insert.assetId, { state: "error" }));
}

/** Preview media for an insert at its own time; null while loading. `playing` keeps video in step. */
export function previewInsertFrame(
  insert: ClipInsert,
  insertTime: number,
  playing: boolean,
  onReady: () => void,
): { media: CanvasImageSource; width: number; height: number } | null {
  const entry = previewCache.get(insert.assetId);
  if (!entry) {
    startPreviewLoad(insert, onReady);
    return null;
  }
  if (entry.state === "image") return { media: entry.bitmap, width: entry.bitmap.width, height: entry.bitmap.height };
  if (entry.state !== "video" || !entry.video.videoWidth) return null;
  const { video } = entry;
  const target = Number.isFinite(video.duration) ? Math.min(insertTime, Math.max(0, video.duration - 0.05)) : insertTime;
  if (playing) {
    if (video.paused) void video.play().catch(() => {});
    if (Math.abs(video.currentTime - target) > 0.3) video.currentTime = target;
  } else {
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - target) > 0.04) video.currentTime = target;
  }
  return { media: video, width: video.videoWidth, height: video.videoHeight };
}

/** Pauses preview videos of inserts that aren't on screen. */
export function pauseIdlePreviewInserts(active: readonly ClipInsert[]): void {
  const keep = new Set(active.map((insert) => insert.assetId));
  for (const [assetId, entry] of previewCache) {
    if (entry.state === "video" && !keep.has(assetId) && !entry.video.paused) entry.video.pause();
  }
}
