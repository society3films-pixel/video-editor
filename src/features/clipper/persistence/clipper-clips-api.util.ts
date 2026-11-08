import {
  localRecordGet,
  localRecordPut,
} from "../../../shared/persistence/local-database.util";
import type { ClipperClipBounds } from "../engine/types/segmentation.types";
import type { ClipSourceMode } from "../shared/state.util";
import type { ClipFramingMap } from "../pipeline/clip-framing.util";

export interface ClipperClipSegmentPayload {
  orderIndex: number;
  startSec: number;
  endSec: number;
  wordStartIdx?: number | null;
  wordEndIdx?: number | null;
}

export interface ClipperClipPayload extends ClipperClipBounds {
  label?: string;
  segments: ClipperClipSegmentPayload[];
}

const clipKey = (projectId: string, mode: ClipSourceMode) =>
  `${projectId}:${mode}`;

export async function fetchClipperClips(
  projectId: string,
  mode: ClipSourceMode,
): Promise<ClipperClipPayload[]> {
  return (
    (await localRecordGet<ClipperClipPayload[]>(
      "clipper-clips",
      clipKey(projectId, mode),
    )) ?? []
  );
}

export async function saveClipperClips(
  projectId: string,
  mode: ClipSourceMode,
  clips: ClipperClipPayload[],
): Promise<ClipperClipPayload[]> {
  return localRecordPut(
    "clipper-clips",
    clipKey(projectId, mode),
    projectId,
    clips,
  );
}

export async function fetchDisabledCollageRegions(
  projectId: string,
): Promise<string[]> {
  return (
    (await localRecordGet<string[]>("clipper-collage-regions", projectId)) ?? []
  );
}

export async function saveDisabledCollageRegions(
  projectId: string,
  disabledRegionIds: string[],
): Promise<string[]> {
  return localRecordPut(
    "clipper-collage-regions",
    projectId,
    projectId,
    disabledRegionIds,
  );
}

/** Per-clip framing keyframes (see pipeline/clip-framing.util), one record per project. */
export async function fetchClipFraming(projectId: string): Promise<ClipFramingMap> {
  return (await localRecordGet<ClipFramingMap>("clipper-clip-framing", projectId)) ?? {};
}

export async function saveClipFraming(projectId: string, framing: ClipFramingMap): Promise<ClipFramingMap> {
  return localRecordPut("clipper-clip-framing", projectId, projectId, framing);
}

/** A saved clip-editor session for an edited export, so it can be reopened and tweaked. */
export interface ClipperExportEditRecord {
  version: 1;
  /** The unedited export the edit was made from. */
  baseExportId: string;
  edit: unknown;
}

export async function fetchExportEdit(exportId: string): Promise<ClipperExportEditRecord | null> {
  return localRecordGet<ClipperExportEditRecord>("clipper-export-edits", exportId);
}

export async function saveExportEdit(
  projectId: string,
  exportId: string,
  record: ClipperExportEditRecord,
): Promise<ClipperExportEditRecord> {
  return localRecordPut("clipper-export-edits", exportId, projectId, record);
}
