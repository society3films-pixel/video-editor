/**
 * Renders clips with a look (a built-in trending look or your template) applied, straight from
 * the source video, the same way the editor's Save does: captions, colour and framing in the
 * source render, then cuts, punch-ins, sound effects and the progress bar on top. Each result is
 * a normal export whose edit can be reopened and tweaked in the editor.
 */
import type { ClipEditorSource } from "./clip-editor-source.util";
import { createInitialClipEdit } from "./clip-edit.util";
import { applyTemplate, type EditTemplate } from "./edit-templates.util";
import { measureClipColor } from "./color-measure.util";
import { saveEditedClipperExport } from "./save-edited-export.util";
import { sourceResultFor } from "./source-result.util";

export interface LookRenderOutcome {
  saved: number;
  failed: string[];
}

export async function renderClipsWithLook(
  projectId: string,
  template: EditTemplate,
  formatIdsByClip: Record<number, string[]>,
  getSource: (clipIndex: number, formatId: string) => ClipEditorSource | null,
  run: {
    signal?: AbortSignal;
    onProgress?: (
      done: number,
      total: number,
      label: string,
      ratio: number,
    ) => void;
  } = {},
): Promise<LookRenderOutcome> {
  const jobs = Object.entries(formatIdsByClip).flatMap(([clip, formats]) =>
    formats.map((formatId) => ({ clipIndex: Number(clip), formatId })),
  );
  const failed: string[] = [];
  let saved = 0;
  for (const [index, job] of jobs.entries()) {
    if (run.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const source = getSource(job.clipIndex, job.formatId);
    const label = `Clip ${job.clipIndex + 1}${source ? ` · ${source.formatDef.label}` : ""}`;
    run.onProgress?.(index, jobs.length, label, 0);
    if (!source) {
      failed.push(`${label} (not ready)`);
      continue;
    }
    try {
      const colorCorrection = template.colorGrade?.auto
        ? await measureClipColor(source).catch(() => null)
        : null;
      const edit = applyTemplate(
        {
          ...createInitialClipEdit(source.duration),
          framing: source.framingTrack,
        },
        template,
        {
          captionGroups: source.frameContext.captionGroups,
          words: source.clip.words,
          duration: source.duration,
          colorCorrection,
        },
      );
      await saveEditedClipperExport(
        projectId,
        sourceResultFor(job.clipIndex, source),
        edit,
        source.duration,
        {
          signal: run.signal,
          source,
          needsSourceRender: true,
          onProgress: (ratio) =>
            run.onProgress?.(index, jobs.length, label, ratio),
        },
      );
      saved++;
    } catch (error) {
      if (run.signal?.aborted) throw error;
      failed.push(
        `${label} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  run.onProgress?.(jobs.length, jobs.length, "Done", 1);
  return { saved, failed };
}
