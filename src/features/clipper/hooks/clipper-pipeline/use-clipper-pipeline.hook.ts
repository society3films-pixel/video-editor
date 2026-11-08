import { useCallback, useState } from "react";
import { useClipperPipelineAi } from "./use-clipper-pipeline-ai.hook";
import { useClipperPipelineClips } from "./use-clipper-pipeline-clips.hook";
import { useClipperPipelineCore } from "./use-clipper-pipeline-core.hook";
import { useClipperPipelineManual } from "./use-clipper-pipeline-manual.hook";
import { useClipperPipelineRender } from "./use-clipper-pipeline-render.hook";
import { useClipperPipelineTranscript } from "./use-clipper-pipeline-transcript.hook";
import { useClipperPipelineWorkflow } from "./use-clipper-pipeline-workflow.hook";
import { useClipperResume } from "../use-clipper-resume.hook";
import { buildFrameContext, buildRangeFrameContext } from "../../pipeline/frame-context.util";
import { resolveClipEditorSource, resolveClipEditorSourceForClip } from "../../editor/clip-editor-source.util";
import { clipFramingKey } from "../../pipeline/clip-framing.util";
import { getActiveClips } from "../../pipeline/session.util";
import { findClipByIndex, type ClipperGeneratedClip } from "../../engine/segmentation";
import { isFramingTrackEmpty, type ClipFramingTrack } from "../../engine/render/framing-override.util";
import { saveClipFraming } from "../../persistence/clipper-clips-api.util";
import { appToast } from "../../../../shared/utils/toast.service";
import type { ClipperFormatResult } from "../../shared/state.util";
import type { RangeFrameContextGetter } from "../../engine/types/render.types";
import { INITIAL_PIPELINE_STATE } from "./clipper-pipeline.types";
import type { UseClipperPipelineOptions } from "./clipper-pipeline.types";

export function useClipperPipeline({ project, token, loaded }: UseClipperPipelineOptions) {
  const core = useClipperPipelineCore(project, loaded);
  const {
    state,
    settings,
    refs,
    rangeLocked,
    updateSettings,
    resetSettings,
    reset,
    setActiveClipIndex,
  } = core;
  const { sessionRef, activeClipIndexRef, metadataRef } = refs;
  const { setClipFramingRevision } = core;

  const workflow = useClipperPipelineWorkflow(core, project, token);
  const clips = useClipperPipelineClips(core);
  const ai = useClipperPipelineAi(core);
  const manual = useClipperPipelineManual(core);
  const render = useClipperPipelineRender(core);
  const transcript = useClipperPipelineTranscript(core);

  const [resumeRetryToken, setResumeRetryToken] = useState(0);

  const getRangeFrameContext = useCallback<RangeFrameContextGetter>(
    (range) => {
      const session = sessionRef.current;
      return session ? buildRangeFrameContext(session, settings, range) : null;
    },
    [sessionRef, settings],
  );

  /** Saves a clip's framing to the project; Preview and every later render use it. */
  const saveClipFramingTrack = useCallback(
    async (clip: ClipperGeneratedClip, track: ClipFramingTrack) => {
      const session = sessionRef.current;
      if (!session) return;
      const key = clipFramingKey(clip);
      const next = { ...(session.clipFraming ?? {}) };
      if (isFramingTrackEmpty(track)) delete next[key];
      else next[key] = track;
      session.clipFraming = next;
      setClipFramingRevision((value) => value + 1);
      try {
        await saveClipFraming(project.id, next);
      } catch (error) {
        appToast.error("Couldn't save framing", error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [project.id, sessionRef, setClipFramingRevision],
  );

  /** Re-arms the resume effect after a phase failed, so it restarts that phase. */
  const retryResume = useCallback(() => {
    refs.resumeStartedRef.current = false;
    core.setState((prev) => ({ ...prev, error: null }));
    void core.persistMetadata({}, "uploading");
    setResumeRetryToken((value) => value + 1);
  }, [core, refs.resumeStartedRef]);

  useClipperResume({
    loaded,
    projectId: project.id,
    setState: core.setState,
    setSettingsState: core.setSettingsState,
    setRangeLocked: core.setRangeLocked,
    metadataRef,
    sessionRef,
    abortRef: refs.abortRef,
    resumeStartedRef: refs.resumeStartedRef,
    loadedResumeKeyRef: refs.loadedResumeKeyRef,
    reporter: refs.reporterRef.current,
    initialState: INITIAL_PIPELINE_STATE,
    preparePreviewFromRange: workflow.preparePreviewFromRange,
    resumeFromTranscribe: workflow.resumeFromTranscribe,
    failPhase: workflow.failPhase,
    activeClipIndexRef,
    retryToken: resumeRetryToken,
  });

  return {
    state,
    settings,
    exportCount: render.exportCount,
    updateSettings,
    resetSettings,
    selectFile: workflow.selectFile,
    confirmRange: workflow.confirmRange,
    retryResume,
    clipAgain: workflow.clipAgain,
    renderExports: render.renderExports,
    existingExports: render.existingExports,
    stopRender: render.stopRender,
    refreshExportHistory: render.refreshExportHistory,
    updateExportMetadata: core.updateExportMetadata,
    reset,
    setActiveClipIndex,
    setClipSourceMode: clips.setClipSourceMode,
    resegmentAutoParts: clips.resegmentAutoParts,
    autoPartsSegmentLengthSec: clips.autoPartsSegmentLengthSec,
    autoPartsResegmenting: clips.autoPartsResegmenting,
    deleteAiClip: ai.deleteAiClip,
    deleteAutoPartsClip: clips.deleteAutoPartsClip,
    upsertManualClip: manual.upsertManualClip,
    deleteManualClip: manual.deleteManualClip,
    getFrameContext: (clipIndex?: number) => {
      const session = sessionRef.current;
      if (!session) return null;
      return buildFrameContext(
        session,
        settings,
        clipIndex ?? activeClipIndexRef.current,
      );
    },
    getRangeFrameContext,
    /** Source video + render context for re-rendering an export in the clip editor. */
    getClipEditorSource: (result: ClipperFormatResult) =>
      resolveClipEditorSource(sessionRef.current, settings, result),
    /** Source + render context for a clip (no export yet), previewed in `formatId`. */
    getClipEditorSourceForClip: (clipIndex: number, formatId: string) => {
      const session = sessionRef.current;
      const clip = session ? findClipByIndex(getActiveClips(session), clipIndex) : undefined;
      return session && clip ? resolveClipEditorSourceForClip(session, settings, clip, formatId) : null;
    },
    saveClipFramingTrack,
    clipFramingRevision: core.clipFramingRevision,
    sourceUrl: sessionRef.current?.sourceUrl ?? null,
    rangeLocked,
    disabledCollageRegionIds: clips.disabledCollageRegionIds,
    toggleCollageRegion: clips.toggleCollageRegion,
    ...transcript,
  };
}
