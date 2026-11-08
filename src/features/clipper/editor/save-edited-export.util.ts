import { isTauri } from "../../../shared/utils/platform.util";
import { upsertClipperExport } from "../persistence/clipper-export-db-api.util";
import { createClipperExportId, createClipperExportSink } from "../persistence/export-files.util";
import { assertClipperProjectWritable } from "../persistence/project-write-lifecycle.util";
import {
  resolveClipperExportFileName,
  resolveClipperExportUploadFile,
} from "../persistence/resolve-export-upload-file.util";
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEdit } from "./clip-edit.util";
import { renderClipEdit } from "./render-clip-edit.util";

export interface SaveEditedExportOptions {
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export type SaveEditedExportOutcome =
  | { kind: "saved"; fileName: string }
  | { kind: "downloaded"; fileName: string };

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

async function resolveSourceFile(original: ClipperFormatResult, projectId: string): Promise<File> {
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
 */
export async function saveEditedClipperExport(
  projectId: string,
  original: ClipperFormatResult,
  edit: ClipEdit,
  options: SaveEditedExportOptions = {},
): Promise<SaveEditedExportOutcome> {
  const source = await resolveSourceFile(original, projectId);
  const fileName = buildEditedFileName(original);

  if (!isTauri()) {
    const result = await renderClipEdit(source, edit, options);
    if (result.kind !== "memory") throw new Error("Unexpected render output.");
    downloadBlob(result.blob, fileName);
    return { kind: "downloaded", fileName };
  }

  assertClipperProjectWritable(projectId);
  const sink = await createClipperExportSink(projectId, fileName);
  if (!sink) throw new Error("Export storage is unavailable. Check storage access and retry.");

  try {
    const result = await renderClipEdit(source, edit, { ...options, outputSink: sink.writable });
    const disk = await sink.finalize();
    await upsertClipperExport(projectId, {
      id: createClipperExportId(),
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
      transcriptPlain: original.transcriptPlain,
      transcriptTimestamped: original.transcriptTimestamped,
      socialTitle: original.socialTitle,
      socialShortDescription: original.socialShortDescription,
      socialDescription: original.socialDescription,
      socialDescriptionTimestamped: original.socialDescriptionTimestamped,
      socialHashtags: original.socialHashtags,
    });
    return { kind: "saved", fileName: sink.fileName };
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}
