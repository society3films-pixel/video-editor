/** Stand-in export for a clip that hasn't been exported yet ("source:" ids render from the source video). */
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEditorSource } from "./clip-editor-source.util";

export function sourceResultFor(
  clipIndex: number,
  source: ClipEditorSource,
): ClipperFormatResult {
  return {
    id: `source:${clipIndex}:${source.formatDef.id}`,
    formatId: source.formatDef.id,
    platform: source.formatDef.platform,
    label: source.formatDef.label,
    width: source.outputSize.width,
    height: source.outputSize.height,
    fileSize: 0,
    previewUrl: source.rangeVideoUrl,
    clipIndex,
    exportedAt: "",
    clipStartSec: source.clip.startSec,
    clipEndSec: source.clip.endSec,
  };
}
