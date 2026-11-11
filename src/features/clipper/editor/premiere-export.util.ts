/**
 * "Export to Premiere Pro": an editable timeline instead of a flat video.
 *
 * Writes next to the exports:
 *  - `<name>-premiere.mp4`: the clip with its framing but without burned-in captions (or the
 *    export itself when the project's source video isn't loaded),
 *  - `<name>-premiere.xml`: a Final Cut Pro 7 XML sequence (Premiere: File → Import) with every
 *    kept part and the hook as separate clips, video and audio linked, music on A2,
 *  - `<name>-premiere.srt`: the edited captions on the timeline's clock (Premiere: import, then
 *    drag onto the timeline as captions),
 *  - the music file, when the edit has music.
 * Text overlays, B-roll, sound effects, the progress bar and zoom punch-ins are not carried over.
 */
import { isTauri } from "../../../shared/utils/platform.util";
import { withClipperProjectRender } from "../persistence/project-write-lifecycle.util";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import type { CaptionGroup } from "../lib/media/transcription-export.util";
import { createClipperExportSink } from "../persistence/export-files.util";
import { renderClipperFormat } from "../engine/render/index";
import type { ClipperFormatResult } from "../shared/state.util";
import { prepareExportMedia } from "../lib/media/media-preflight.util";
import { resolveClipperExportFileName } from "../persistence/resolve-export-upload-file.util";
import { applyEditToFrameContext, type ClipEditorSource } from "./clip-editor-source.util";
import { sourceToOutputTime, type ClipEdit, type ClipEditSegment } from "./clip-edit.util";
import { renderSegmentsFor } from "./hook.util";
import { loadEditorAsset } from "./editor-assets.util";
import { resolveSourceFile } from "./save-edited-export.util";

export interface FrameRate {
  timebase: number;
  ntsc: boolean;
}

/** FCP XML rate for a measured frame rate (29.97 → 30 NTSC). */
export function frameRateFor(fps: number): FrameRate {
  const known = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const nearest = known.reduce((best, rate) => (Math.abs(rate - fps) < Math.abs(best - fps) ? rate : best), 30);
  const ntsc = !Number.isInteger(nearest);
  return { timebase: ntsc ? Math.round(nearest) : nearest, ntsc };
}

function fpsOf(rate: FrameRate): number {
  return rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** file:// URL Premiere accepts for an absolute path (Windows or POSIX); a bare name otherwise. */
export function pathUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join("/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file://localhost/${encoded}`;
  if (normalized.startsWith("/")) return `file://localhost${encoded}`;
  return encoded;
}

export interface PremiereMedia {
  name: string;
  path: string;
  durationSec: number;
}

export interface PremiereSequenceInput {
  name: string;
  width: number;
  height: number;
  rate: FrameRate;
  video: PremiereMedia;
  /** Parts in the video file's time, in timeline order (hook first). */
  parts: readonly Pick<ClipEditSegment, "start" | "end">[];
  music?: (PremiereMedia & { startSec: number }) | null;
}

function rateXml(rate: FrameRate): string {
  return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
}

export function buildPremiereXml(input: PremiereSequenceInput): string {
  const fps = fpsOf(input.rate);
  const frames = (sec: number) => Math.round(sec * fps);
  const rate = rateXml(input.rate);
  const videoFrames = frames(input.video.durationSec);
  const fileXml = (id: string, media: PremiereMedia, withVideo: boolean) =>
    `<file id="${id}"><name>${escapeXml(media.name)}</name><pathurl>${escapeXml(pathUrl(media.path))}</pathurl>${rate}<duration>${frames(media.durationSec)}</duration>` +
    `<media>${withVideo ? `<video><samplecharacteristics>${rate}<width>${input.width}</width><height>${input.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>` : ""}` +
    `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`;

  let cursor = 0;
  const placed = input.parts.map((part, index) => {
    const inFrame = frames(part.start);
    const outFrame = Math.max(inFrame + 1, frames(part.end));
    const start = cursor;
    cursor += outFrame - inFrame;
    return { index: index + 1, inFrame, outFrame, start, end: cursor };
  });
  const total = cursor;
  const link = (index: number) =>
    `<link><linkclipref>clipitem-v${index}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${index}</clipindex></link>` +
    `<link><linkclipref>clipitem-a${index}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${index}</clipindex></link>`;
  const item = (kind: "v" | "a", p: (typeof placed)[number]) =>
    `<clipitem id="clipitem-${kind}${p.index}"><name>${escapeXml(input.video.name)}</name><enabled>TRUE</enabled><duration>${videoFrames}</duration>${rate}` +
    `<start>${p.start}</start><end>${p.end}</end><in>${p.inFrame}</in><out>${p.outFrame}</out>` +
    (p.index === 1 && kind === "v" ? fileXml("file-1", input.video, true) : `<file id="file-1"/>`) +
    (kind === "a" ? `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` : "") +
    link(p.index) +
    `</clipitem>`;

  let musicTrack = "";
  if (input.music) {
    const musicFrames = frames(input.music.durationSec);
    const inFrame = Math.min(frames(input.music.startSec), Math.max(0, musicFrames - 1));
    const length = Math.min(total, musicFrames - inFrame);
    musicTrack =
      `<track><clipitem id="clipitem-music"><name>${escapeXml(input.music.name)}</name><enabled>TRUE</enabled><duration>${musicFrames}</duration>${rate}` +
      `<start>0</start><end>${length}</end><in>${inFrame}</in><out>${inFrame + length}</out>${fileXml("file-music", input.music, false)}` +
      `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem></track>`;
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">` +
    `<sequence id="sequence-1"><name>${escapeXml(input.name)}</name><duration>${total}</duration>${rate}` +
    `<media><video><format><samplecharacteristics>${rate}<width>${input.width}</width><height>${input.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>` +
    `<track>${placed.map((p) => item("v", p)).join("")}</track></video>` +
    `<audio><track>${placed.map((p) => item("a", p)).join("")}</track>${musicTrack}</audio></media></sequence></xmeml>\n`
  );
}

/** file:///… URL for FCPXML (Final Cut Pro). */
function fileUrl(path: string): string {
  const url = pathUrl(path);
  return url.startsWith("file://localhost/") ? `file:///${url.slice("file://localhost/".length)}` : url;
}

/**
 * Final Cut Pro (FCPXML 1.10) version of the same timeline: the parts as asset clips on the
 * primary storyline, the music as a connected clip below.
 */
export function buildFcpxml(input: PremiereSequenceInput): string {
  const fps = fpsOf(input.rate);
  const frames = (sec: number) => Math.round(sec * fps);
  // Times as frame-exact rationals.
  const time = (frameCount: number) =>
    input.rate.ntsc ? `${frameCount * 1001}/${input.rate.timebase * 1000}s` : `${frameCount}/${input.rate.timebase}s`;
  const frameDuration = input.rate.ntsc ? `1001/${input.rate.timebase * 1000}s` : `1/${input.rate.timebase}s`;
  let cursor = 0;
  const clips = input.parts.map((part, index) => {
    const start = frames(part.start);
    const length = Math.max(1, frames(part.end) - start);
    const offset = cursor;
    cursor += length;
    return { index, start, length, offset };
  });
  const total = cursor;
  const musicLength = input.music ? Math.min(total, frames(input.music.durationSec) - frames(input.music.startSec)) : 0;
  const musicClip =
    input.music && musicLength > 0
      ? `<asset-clip ref="r3" lane="-1" offset="${time(0)}" start="${time(frames(input.music.startSec))}" duration="${time(musicLength)}" name="${escapeXml(input.music.name)}" audioRole="music"/>`
      : "";
  const spine = clips
    .map(
      (clip) =>
        `<asset-clip ref="r2" offset="${time(clip.offset)}" start="${time(clip.start)}" duration="${time(clip.length)}" name="${escapeXml(input.video.name)} ${clip.index + 1}">${clip.index === 0 ? musicClip : ""}</asset-clip>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>` +
    `<format id="r1" frameDuration="${frameDuration}" width="${input.width}" height="${input.height}"/>` +
    `<asset id="r2" name="${escapeXml(input.video.name)}" start="0s" duration="${time(frames(input.video.durationSec))}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2">` +
    `<media-rep kind="original-media" src="${escapeXml(fileUrl(input.video.path))}"/></asset>` +
    (input.music
      ? `<asset id="r3" name="${escapeXml(input.music.name)}" start="0s" duration="${time(frames(input.music.durationSec))}" hasAudio="1" audioSources="1" audioChannels="2"><media-rep kind="original-media" src="${escapeXml(fileUrl(input.music.path))}"/></asset>`
      : "") +
    `</resources><library><event name="Open Clipper"><project name="${escapeXml(input.name)}"><sequence format="r1" duration="${time(total)}" tcStart="0s" tcFormat="NDF"><spine>${spine}</spine></sequence></project></event></library></fcpxml>\n`
  );
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/**
 * Captions on the exported timeline's clock: lines in cut parts are dropped, the rest are shifted
 * by the cuts and by the hook played first. Masked words stay masked.
 */
export function buildSrt(groups: readonly CaptionGroup[], edit: Pick<ClipEdit, "segments" | "hook">): string {
  const hookLength = edit.hook ? edit.hook.end - edit.hook.start : 0;
  const kept = (t: number) => edit.segments.some((segment) => t >= segment.start && t < segment.end);
  const entries: string[] = [];
  for (const group of groups) {
    const words = group.words.filter((word) => !word.deleted && kept((word.start + word.end) / 2));
    if (!words.length) continue;
    const start = sourceToOutputTime(edit.segments, words[0]!.start) + hookLength;
    const end = Math.max(start + 0.2, sourceToOutputTime(edit.segments, words[words.length - 1]!.end) + hookLength);
    entries.push(`${entries.length + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${words.map((w) => w.text).join(" ")}\n`);
  }
  return entries.join("\n");
}

// ---- Exporting ---------------------------------------------------------------------------------

async function measureVideo(file: File): Promise<{ durationSec: number; fps: number; width: number; height: number }> {
  const input = await createMediabunnyInput(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The video has no picture.");
    const stats = await track.computePacketStats(120);
    return { durationSec: await input.computeDuration(), fps: stats.averagePacketRate || 30, width: track.displayWidth, height: track.displayHeight };
  } finally {
    input.dispose();
  }
}

async function audioDuration(file: File): Promise<number> {
  const input = await createMediabunnyInput(file);
  try {
    return await input.computeDuration();
  } finally {
    input.dispose();
  }
}

/** Saves bytes next to the exports (desktop) and returns the absolute path; downloads on the web. */
async function writeFile(projectId: string, fileName: string, data: Blob): Promise<string> {
  if (!isTauri()) {
    const url = URL.createObjectURL(data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return fileName;
  }
  const sink = await createClipperExportSink(projectId, fileName);
  if (!sink) throw new Error("Export storage is unavailable.");
  try {
    const writer = sink.writable.getWriter();
    await writer.write({ type: "write", data: new Uint8Array(await data.arrayBuffer()), position: 0 });
    await writer.close();
    const disk = await sink.finalize();
    return disk.filePath || disk.displayPath || fileName;
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}

export interface PremiereExportResult {
  folderHint: string;
  files: string[];
  usedCleanRender: boolean;
}

export async function exportToPremiere(
  projectId: string,
  base: ClipperFormatResult,
  edit: ClipEdit,
  source: ClipEditorSource | null,
  captionGroups: readonly CaptionGroup[],
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void } = {},
): Promise<PremiereExportResult> {
  if (!isTauri()) return exportToPremiereUnlocked(projectId, base, edit, source, captionGroups, options);
  // Same render slot as saving, so it doesn't run alongside the render queue.
  return withClipperProjectRender(projectId, options.signal ?? new AbortController().signal, (signal) =>
    exportToPremiereUnlocked(projectId, base, edit, source, captionGroups, { ...options, signal }),
  );
}

async function exportToPremiereUnlocked(
  projectId: string,
  base: ClipperFormatResult,
  edit: ClipEdit,
  source: ClipEditorSource | null,
  captionGroups: readonly CaptionGroup[],
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void },
): Promise<PremiereExportResult> {
  const stem = resolveClipperExportFileName(base).replace(/\.mp4$/i, "").replace(/-edited-\d{8}-\d{6}$/, "") + "-premiere";
  const files: string[] = [];
  const signal = options.signal ?? new AbortController().signal;

  // 1. The video: framing without captions when the source is loaded, else the export as is.
  let videoFile: File;
  let videoPath: string;
  if (source) {
    const rangeFile = await prepareExportMedia(source.rangeFile, projectId, signal, (ratio) => options.onProgress?.(ratio * 0.05));
    const frameContext = applyEditToFrameContext(source.frameContext, { ...edit, captionsVisible: false });
    const render = await renderClipperFormat(rangeFile, source.formatDef, frameContext, {
      signal,
      clipWindow: { segments: source.clip.segments },
      onProgress: (ratio) => options.onProgress?.(0.05 + ratio * 0.85),
    });
    if (render.kind !== "memory") throw new Error("Unexpected render output.");
    videoFile = new File([render.blob], `${stem}.mp4`, { type: "video/mp4" });
    videoPath = await writeFile(projectId, `${stem}.mp4`, render.blob);
  } else {
    videoFile = await resolveSourceFile(base, projectId);
    videoPath = await writeFile(projectId, `${stem}.mp4`, videoFile);
  }
  files.push(`${stem}.mp4`);
  const video = await measureVideo(videoFile);

  // 2. Music, copied next to the project so Premiere can find it.
  let music: PremiereSequenceInput["music"] = null;
  if (edit.music) {
    const musicFile = await loadEditorAsset(edit.music.assetId);
    if (musicFile) {
      const extension = /\.[a-z0-9]+$/i.exec(musicFile.name)?.[0] ?? ".mp3";
      const musicName = `${stem}-music${extension}`;
      const musicPath = await writeFile(projectId, musicName, musicFile);
      files.push(musicName);
      music = { name: musicName, path: musicPath, durationSec: await audioDuration(musicFile), startSec: edit.music.startSec };
    }
  }

  // 3. Timeline and captions.
  const xml = buildPremiereXml({
    name: stem,
    width: video.width,
    height: video.height,
    rate: frameRateFor(video.fps),
    video: { name: `${stem}.mp4`, path: videoPath, durationSec: video.durationSec },
    parts: renderSegmentsFor(edit),
    music,
  });
  await writeFile(projectId, `${stem}.xml`, new Blob([xml], { type: "application/xml" }));
  files.push(`${stem}.xml`);
  const fcpxml = buildFcpxml({
    name: stem,
    width: video.width,
    height: video.height,
    rate: frameRateFor(video.fps),
    video: { name: `${stem}.mp4`, path: videoPath, durationSec: video.durationSec },
    parts: renderSegmentsFor(edit),
    music,
  });
  await writeFile(projectId, `${stem}.fcpxml`, new Blob([fcpxml], { type: "application/xml" }));
  files.push(`${stem}.fcpxml`);
  const srt = buildSrt(captionGroups, edit);
  if (srt.trim()) {
    await writeFile(projectId, `${stem}.srt`, new Blob([srt], { type: "text/plain" }));
    files.push(`${stem}.srt`);
  }
  options.onProgress?.(1);
  return { folderHint: videoPath.replace(/[\\/][^\\/]*$/, ""), files, usedCleanRender: Boolean(source) };
}
