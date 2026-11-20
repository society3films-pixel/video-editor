import { isTauri } from "../../../shared/utils/platform.util";
import { upsertClipperExport } from "../persistence/clipper-export-db-api.util";
import { createClipperExportId, createClipperExportSink } from "../persistence/export-files.util";
import { assertClipperProjectWritable } from "../persistence/project-write-lifecycle.util";
import {
  resolveClipperExportFileName,
  resolveClipperExportUploadFile,
} from "../persistence/resolve-export-upload-file.util";
import type { ClipperFormatResult } from "../shared/state.util";
import type { StreamTargetChunk } from "mediabunny";
import { renderClipperFormat } from "../engine/render/index";
import { prepareExportMedia } from "../lib/media/media-preflight.util";
import { withClipperProjectRender } from "../persistence/project-write-lifecycle.util";
import { saveExportEdit } from "../persistence/clipper-clips-api.util";
import { clipEditNeedsPostProcess, type ClipEdit } from "./clip-edit.util";
import { toPersistedClipEdit } from "./clip-edit-persist.util";
import { applyEditToFrameContext, type ClipEditorSource } from "./clip-editor-source.util";
import { renderClipEdit } from "./render-clip-edit.util";
import { drawClipperCaptions } from "../engine/render/canvas-draw.util";
import { localTimeToSourceTime } from "../engine/segmentation/clip-time.util";

export interface SaveEditedExportOptions {
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
  /** Needed when the edit changes captions or framing. */
  source?: ClipEditorSource | null;
  /**
   * Re-render from the source video (captions or framing changed, or the export is older than
   * the clip's current render inputs). Otherwise the export file itself is edited.
   */
  needsSourceRender: boolean;
  /** Export whose title, description and hashtags the new export copies; defaults to the base. */
  metadataFrom?: ClipperFormatResult;
}

type RenderToTarget = (
  outputSink: WritableStream<StreamTargetChunk> | undefined,
) => Promise<{ blob?: Blob; width: number; height: number; cover?: Blob }>;

/**
 * Builds the render for an edit. Caption/framing changes re-render the clip from the source
 * video first (into memory); cuts, audio, fades and text are then applied on top.
 */
function buildEditRender(
  projectId: string,
  sourceFile: () => Promise<File>,
  edit: ClipEdit,
  duration: number,
  options: SaveEditedExportOptions,
): RenderToTarget {
  const { signal, onProgress, source } = options;
  const needsSource = options.needsSourceRender;
  const needsPost = clipEditNeedsPostProcess(edit, duration);

  if (!needsSource) {
    return async (outputSink) => {
      const result = await renderClipEdit(await sourceFile(), edit, { signal, onProgress, outputSink, multicam: multicamFor(source, edit) });
      return { blob: result.kind === "memory" ? result.blob : undefined, width: result.width, height: result.height, cover: result.cover };
    };
  }
  if (!source) {
    throw new Error("Caption and framing changes need the project's source video, which isn't loaded.");
  }

  return async (outputSink) => {
    const abortSignal = signal ?? new AbortController().signal;
    const sourceShare = needsPost ? 0.6 : 0.95;
    const rangeFile = await prepareExportMedia(source.rangeFile, projectId, abortSignal, (ratio) =>
      onProgress?.(ratio * 0.05),
    );
    const frameContext = applyEditToFrameContext(source.frameContext, edit);
    const sourceRender = await renderClipperFormat(rangeFile, source.formatDef, frameContext, {
      signal: abortSignal,
      clipWindow: { segments: source.clip.segments },
      outputSink: needsPost ? undefined : outputSink,
      onProgress: (ratio) => onProgress?.(0.05 + ratio * sourceShare),
    });
    const { width, height } = source.outputSize;
    if (!needsPost) {
      return { blob: sourceRender.kind === "memory" ? sourceRender.blob : undefined, width, height };
    }
    if (sourceRender.kind !== "memory") throw new Error("Unexpected render output.");
    const rendered = new File([sourceRender.blob], "edited-source.mp4", { type: "video/mp4" });
    const result = await renderClipEdit(rendered, edit, {
      signal,
      outputSink,
      multicam: multicamFor(source, edit),
      onProgress: (ratio) => onProgress?.(0.05 + sourceShare + ratio * (0.95 - sourceShare)),
    });
    return { blob: result.kind === "memory" ? result.blob : undefined, width: result.width, height: result.height, cover: result.cover };
  };
}

/** Multicam needs the clip's windows (to sync angles) and the captions to draw over angle frames. */
function multicamFor(source: ClipEditorSource | null | undefined, edit: ClipEdit) {
  if (!source || !edit.angles?.length) return undefined;
  const context = applyEditToFrameContext(source.frameContext, edit);
  return {
    clipSegments: source.clip.segments,
    drawCaptions: (ctx: OffscreenCanvasRenderingContext2D, t: number, width: number, height: number) =>
      drawClipperCaptions(ctx, { width, height }, localTimeToSourceTime(source.clip.segments, t), context),
  };
}

export type SaveEditedExportOutcome =
  | { kind: "saved"; fileName: string; coverFileName?: string }
  | { kind: "downloaded"; fileName: string; coverFileName?: string };

function coverFileNameFor(videoFileName: string): string {
  return videoFileName.replace(/\.mp4$/i, "") + "-cover.png";
}

/** Writes the cover PNG next to the export; failures only warn (the video is what matters). */
async function saveCoverImage(projectId: string, videoFileName: string, cover: Blob): Promise<string | undefined> {
  try {
    const sink = await createClipperExportSink(projectId, coverFileNameFor(videoFileName));
    if (!sink) return undefined;
    try {
      const writer = sink.writable.getWriter();
      await writer.write({ type: "write", data: new Uint8Array(await cover.arrayBuffer()), position: 0 });
      await writer.close();
      await sink.finalize();
      return sink.fileName;
    } catch (error) {
      await sink.abort().catch(() => {});
      throw error;
    }
  } catch (error) {
    console.warn("[ClipEditor] Could not save the cover image:", error);
    return undefined;
  }
}

function buildEditedFileName(original: ClipperFormatResult): string {
  const stem = resolveClipperExportFileName(original)
    .replace(/\.mp4$/i, "")
    .replace(/-edited-\d{8}-\d{6}$/, "");
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stem}-edited-${stamp}.mp4`;
}

/** The file cuts and text are applied to: the export itself (in memory or on disk). */
export async function resolveSourceFile(original: ClipperFormatResult, projectId: string): Promise<File> {
  if (original.file) return original.file;
  if (original.blob) return new File([original.blob], resolveClipperExportFileName(original), { type: "video/mp4" });
  const file = await resolveClipperExportUploadFile(original, projectId);
  if (!file) throw new Error("The export file could not be found on disk.");
  return file;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Renders the edit and saves it as a **new** export next to the original (the original file is
 * never touched), copying its clip and social metadata so it shows up in Exports and Publish.
 * The edit itself is saved with the new export so the editor can reopen it.
 *
 * `original` is the unedited base export: its file is what cuts and text are applied to.
 */
export async function saveEditedClipperExport(
  projectId: string,
  original: ClipperFormatResult,
  edit: ClipEdit,
  duration: number,
  options: SaveEditedExportOptions,
): Promise<SaveEditedExportOutcome> {
  const fileName = buildEditedFileName(original);
  const sourceFile = () => resolveSourceFile(original, projectId);

  if (!isTauri()) {
    const result = await buildEditRender(projectId, sourceFile, edit, duration, options)(undefined);
    if (!result.blob) throw new Error("Unexpected render output.");
    downloadBlob(result.blob, fileName);
    if (result.cover) downloadBlob(result.cover, coverFileNameFor(fileName));
    return { kind: "downloaded", fileName, coverFileName: result.cover ? coverFileNameFor(fileName) : undefined };
  }

  return withClipperProjectRender(projectId, options.signal ?? new AbortController().signal, async (signal) => {
    assertClipperProjectWritable(projectId);
    // The job signal also aborts when the project is closed mid-save.
    const render = buildEditRender(projectId, sourceFile, edit, duration, { ...options, signal });
    const sink = await createClipperExportSink(projectId, fileName);
    if (!sink) throw new Error("Export storage is unavailable. Check storage access and retry.");

    try {
      const result = await render(sink.writable);
      const disk = await sink.finalize();
      const meta = options.metadataFrom ?? original;
      const exportId = createClipperExportId();
      await upsertClipperExport(projectId, {
        id: exportId,
        clipIndex: original.clipIndex,
        formatId: original.formatId,
        fileName: sink.fileName,
        relativePath: disk.relativePath,
        width: result.width,
        height: result.height,
        fileSize: disk.fileSize,
        exportedAt: new Date().toISOString(),
        clipStartSec: original.clipStartSec,
        clipEndSec: original.clipEndSec,
        transcriptPlain: meta.transcriptPlain,
        transcriptTimestamped: meta.transcriptTimestamped,
        socialTitle: meta.socialTitle,
        socialShortDescription: meta.socialShortDescription,
        socialDescription: meta.socialDescription,
        socialDescriptionTimestamped: meta.socialDescriptionTimestamped,
        socialHashtags: meta.socialHashtags,
      });
      await saveExportEdit(projectId, exportId, {
        version: 1,
        baseExportId: original.id,
        edit: toPersistedClipEdit(edit),
      }).catch((error) => console.warn("[ClipEditor] Could not save the edit for reopening:", error));
      const coverFileName = result.cover ? await saveCoverImage(projectId, sink.fileName, result.cover) : undefined;
      return { kind: "saved" as const, fileName: sink.fileName, coverFileName };
    } catch (error) {
      await sink.abort().catch(() => {});
      throw error;
    }
  });
}
