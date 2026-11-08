import { fetchExportEdit } from "../persistence/clipper-clips-api.util";
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEditorBridge, ClipEditorSource } from "./clip-editor-source.util";
import { fromPersistedClipEdit, type PersistedClipEdit } from "./clip-edit-persist.util";

export interface ExportEditorTarget {
  /** The unedited export whose file is edited. */
  base: ClipperFormatResult;
  opened: ClipperFormatResult;
  source: ClipEditorSource | null;
  savedEdit: PersistedClipEdit | null;
  /** Why a saved edit could only be partly restored, if it couldn't. */
  warning?: string;
}

/**
 * Works out how to open an export in the editor. An edited export reopens its saved edit on top
 * of the original (base) export, so earlier cuts, text and caption fixes can be tweaked.
 */
export async function resolveExportEditorTarget(
  opened: ClipperFormatResult,
  allExports: readonly ClipperFormatResult[],
  bridge: ClipEditorBridge | undefined,
): Promise<ExportEditorTarget> {
  const record = await fetchExportEdit(opened.id).catch(() => null);
  const base = record ? allExports.find((item) => item.id === record.baseExportId && !item.isMissing) : undefined;
  const source = bridge?.getSource(base ?? opened) ?? null;

  if (!record) return { base: opened, opened, source, savedEdit: null };

  const duration = source?.duration ?? Math.max(0, (opened.clipEndSec ?? 0) - (opened.clipStartSec ?? 0));
  const savedEdit = duration > 0 ? fromPersistedClipEdit(record.edit, duration) : null;
  if (!savedEdit) {
    return { base: opened, opened, source, savedEdit: null, warning: "The saved edit couldn't be read, so this opens the edited video as it is." };
  }
  if (!base && !source) {
    return {
      base: opened,
      opened,
      source,
      savedEdit: null,
      warning: "The original export for this edit is gone, so this opens the edited video as it is.",
    };
  }
  if (!source && (savedEdit.captionGroups || savedEdit.captionsVisible !== null)) {
    return {
      base: base!,
      opened,
      source,
      savedEdit: { ...savedEdit, captionGroups: null, captionsVisible: null },
      warning: "Caption changes need the project's source video, so they weren't restored.",
    };
  }
  return { base: base ?? opened, opened, source, savedEdit };
}
