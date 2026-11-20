/**
 * Autosave: the editor keeps a draft of unsaved changes (every couple of seconds), so a crash or an
 * accidental close doesn't lose work. Drafts are offered back the next time the same export or
 * clip is opened, and removed once the edit is saved or discarded.
 */
import { localRecordDelete, localRecordGet, localRecordPut } from "../../../shared/persistence/local-database.util";
import type { ClipFramingTrack } from "../engine/render/framing-override.util";
import type { ClipperClipSegmentWindow } from "../engine/segmentation/segmentation.types";
import type { ClipEdit } from "./clip-edit.util";
import { toPersistedClipEdit, type PersistedClipEdit } from "./clip-edit-persist.util";

const NAMESPACE = "clipper-editor-drafts";

export interface EditorDraft {
  savedAt: string;
  edit: PersistedClipEdit;
  framing: ClipFramingTrack | null;
}

/** Key for an export, or for a clip when editing framing only. */
export function draftKey(projectId: string, exportId: string | undefined, clipSegments: readonly ClipperClipSegmentWindow[] | undefined): string {
  if (exportId) return `${projectId}:export:${exportId}`;
  return `${projectId}:clip:${(clipSegments ?? []).map((s) => `${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}`).join("_")}`;
}

export async function loadDraft(key: string): Promise<EditorDraft | null> {
  return localRecordGet<EditorDraft>(NAMESPACE, key).catch(() => null);
}

export async function saveDraft(key: string, projectId: string, edit: ClipEdit): Promise<void> {
  const draft: EditorDraft = { savedAt: new Date().toISOString(), edit: toPersistedClipEdit(edit), framing: edit.framing };
  await localRecordPut(NAMESPACE, key, projectId, draft).catch((error) => console.warn("[editor] Autosave failed:", error));
}

export async function deleteDraft(key: string): Promise<void> {
  await localRecordDelete(NAMESPACE, key).catch(() => {});
}
