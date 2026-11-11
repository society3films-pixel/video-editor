/**
 * Edits exports without opening the editor: applies Auto edit and/or an AI instruction to each
 * clip, saves framing changes to the clip, and renders a new edited export, like the editor's
 * Save does.
 */
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEditorBridge } from "./clip-editor-source.util";
import { resolveExportEditorTarget } from "./open-export-editor.util";
import {
  clipEditChangesCaptions,
  clipEditNeedsPostProcess,
  createInitialClipEdit,
  framingShotBoundaries,
  framingTracksEqual,
  type ClipEdit,
} from "./clip-edit.util";
import { applyAutoEdit, measureLevelGain, type AutoEditOptions } from "./auto-edit.util";
import { resolveSourceFile, saveEditedClipperExport } from "./save-edited-export.util";
import { buildAiEditMessages } from "./ai-editor/ai-editor-prompt.util";
import { applyAiEditPlan, parseAiEditReply } from "./ai-editor/ai-editor-ops.util";
import { requestEdit } from "./ai-editor/ai-editor-providers.util";
import type { AiChoice } from "./ai-editor/ai-choice.util";

export interface BatchEditOptions {
  auto: AutoEditOptions | null;
  instruction: string;
  choice: AiChoice | null;
}

export type BatchEditOutcome =
  | { kind: "saved"; fileName: string; notes: string[] }
  | { kind: "skipped"; reason: string };

/** The newest export of each clip in each format: what "edit all clips" works on. */
export function latestExportPerClip(exports: readonly ClipperFormatResult[]): ClipperFormatResult[] {
  const latest = new Map<string, ClipperFormatResult>();
  for (const item of exports) {
    if (item.isMissing || item.registrationPending) continue;
    const key = `${item.formatId}|${item.clipStartSec?.toFixed(2) ?? item.clipIndex}|${item.clipEndSec?.toFixed(2) ?? ""}`;
    const current = latest.get(key);
    if (!current || item.exportedAt > current.exportedAt) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => a.clipIndex - b.clipIndex || a.formatId.localeCompare(b.formatId));
}

export async function batchEditExport(
  projectId: string,
  opened: ClipperFormatResult,
  allExports: readonly ClipperFormatResult[],
  bridge: ClipEditorBridge,
  options: BatchEditOptions,
  run: { signal?: AbortSignal; onProgress?: (ratio: number) => void },
): Promise<BatchEditOutcome> {
  const target = await resolveExportEditorTarget(opened, allExports, bridge);
  const source = target.source;
  if (!source) return { kind: "skipped", reason: "the project's source video for this clip isn't loaded" };
  const duration = source.duration;
  const notes: string[] = [];

  let edit: ClipEdit = { ...(target.savedEdit ?? createInitialClipEdit(duration)), framing: source.framingTrack };
  const baseline = JSON.stringify(edit);
  const words = source.clip.words;

  if (options.auto) {
    let levelGain: number | null = null;
    if (options.auto.levelVolume) {
      const measured = await measureLevelGain(await resolveSourceFile(target.base, projectId), run.signal).catch(() => null);
      levelGain = measured?.gain ?? null;
    }
    const faceCache = source.frameContext.faceCache;
    edit = applyAutoEdit(
      edit,
      {
        duration,
        words,
        socialTitle: opened.socialTitle,
        framing: faceCache
          ? {
              aiShotBoundaries: source.aiShotBoundaries,
              faceSamples: faceCache.sortedSamples(),
              clipSegments: source.clip.segments,
              outputAspect: source.outputSize.width / Math.max(1, source.outputSize.height),
            }
          : undefined,
        levelGain,
      },
      options.auto,
    ).edit;
  }

  if (options.instruction.trim() && options.choice) {
    const captionGroups = edit.captionGroups ?? source.frameContext.captionGroups;
    const messages = buildAiEditMessages(options.instruction, edit, {
      duration,
      words,
      captionGroups,
      shotBoundaries: edit.framing ? framingShotBoundaries(edit.framing, source.aiShotBoundaries) : [],
      canChangeSource: true,
      title: opened.socialTitle,
    });
    const plan = parseAiEditReply(await requestEdit(options.choice.provider, options.choice.model, messages, run.signal));
    const outcome = applyAiEditPlan(edit, plan, {
      duration,
      words,
      captionGroups,
      aiShotBoundaries: source.aiShotBoundaries,
      canChangeSource: true,
    });
    edit = outcome.edit;
    notes.push(...outcome.skipped);
  }

  if (JSON.stringify(edit) === baseline) return { kind: "skipped", reason: "nothing to change" };

  const framingChanged = !framingTracksEqual(edit.framing, source.framingTrack);
  if (framingChanged && edit.framing) await bridge.saveFraming(source.clip, edit.framing);
  const stale = Boolean(target.base.renderSignature && target.base.renderSignature !== source.renderSignature);
  const needsSourceRender = clipEditChangesCaptions(edit) || framingChanged || stale;
  if (!needsSourceRender && !clipEditNeedsPostProcess(edit, duration)) return { kind: "skipped", reason: "nothing to change" };

  const saved = await saveEditedClipperExport(projectId, target.base, edit, duration, {
    signal: run.signal,
    onProgress: run.onProgress,
    source,
    needsSourceRender,
    metadataFrom: opened,
  });
  return { kind: "saved", fileName: saved.fileName, notes };
}
