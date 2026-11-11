import { checkClipFraming } from "../../editor/framing-check.util";
import { planFramingWithLearning } from "../../editor/framing-learning.util";
import { ClipperFramingReport, type FramingReportEntry } from "../preview/clipper-framing-report.component";
import React, { useMemo, useState } from "react";
import { Box, Text } from "@chakra-ui/react";
import { ClipperPreview } from "../preview/clipper-preview.component";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { ClipperTranscriptEditProvider } from "../clipper-transcript-edit.context";
import type { useClipperSessionView } from "../../hooks/use-clipper-session-view.hook";
import { ClipperVideoEditor } from "../../editor/clipper-video-editor.component";
import { CLIPPER_FORMAT_DEFS } from "../../shared/formats.util";
import { appToast } from "../../../../shared/utils/toast.service";

/** Framing only matters for cropped formats. */
const FRAMING_FORMATS = CLIPPER_FORMAT_DEFS.filter((format) => format.mode === "crop");
const DEFAULT_FRAMING_FORMAT = FRAMING_FORMATS.find((format) => format.aspectId === "9-16") ?? FRAMING_FORMATS[0];

type SessionView = ReturnType<typeof useClipperSessionView>;

export interface ClipperSessionPreviewPanelProps {
  session: SessionView;
  settingsDrawerVisible?: boolean;
}

export const ClipperSessionPreviewPanel: React.FC<ClipperSessionPreviewPanelProps> = ({
  session,
  settingsDrawerVisible = true,
}) => {
  const { theme, errorPanel } = useClipperUi();
  const {
    project,
    state,
    settings,
    updateSettings,
    getFrameContext,
    getRangeFrameContext,
    setActiveClipIndex,
    setClipSourceMode,
    resegmentAutoParts,
    autoPartsSegmentLengthSec,
    autoPartsResegmenting,
    deleteAiClip,
    deleteAutoPartsClip,
    upsertManualClip,
    deleteManualClip,
    disabledCollageRegionIds,
    toggleCollageRegion,
    applyTranscriptOp,
    undoTranscriptEdit,
    redoTranscriptEdit,
    isRendering,
    renderQueue,
    getClipEditorSourceForClip,
    saveClipFramingTrack,
  } = session;
  // The source is resolved once per open/format switch so the editor gets a stable object.
  const [framingEditor, setFramingEditor] = useState<{
    clipIndex: number;
    source: NonNullable<ReturnType<typeof getClipEditorSourceForClip>>;
  } | null>(null);

  const openFramingEditor = (clipIndex: number) => {
    const source = DEFAULT_FRAMING_FORMAT ? getClipEditorSourceForClip(clipIndex, DEFAULT_FRAMING_FORMAT.id) : null;
    if (!source) {
      appToast.info("Framing isn't ready yet", "Wait for the video analysis to finish, then try again.");
      return;
    }
    setFramingEditor({ clipIndex, source });
  };

  const [framingReport, setFramingReport] = useState<FramingReportEntry[] | null>(null);
  const checkFraming = (clipIndices: number[]) => {
    if (!DEFAULT_FRAMING_FORMAT) return;
    setFramingReport(
      clipIndices.map((clipIndex) => {
        const source = getClipEditorSourceForClip(clipIndex, DEFAULT_FRAMING_FORMAT.id);
        return { clipIndex, issues: source ? checkClipFraming(source) : null };
      }),
    );
  };

  const switchFramingFormat = (formatId: string) => {
    if (!framingEditor) return;
    const source = getClipEditorSourceForClip(framingEditor.clipIndex, formatId);
    if (source) setFramingEditor({ ...framingEditor, source });
  };
  const transcriptEditActions = useMemo(
    () => ({ applyTranscriptOp, undoTranscriptEdit, redoTranscriptEdit }),
    [applyTranscriptOp, redoTranscriptEdit, undoTranscriptEdit],
  );

  return (
    <ClipperTranscriptEditProvider actions={transcriptEditActions}>
      {state.error && (
        <Box mb={4} p={4} borderRadius="xl" {...errorPanel}>
          <Text color={theme.status.danger} fontSize="sm">
            {state.error}
          </Text>
        </Box>
      )}
      <ClipperPreview
        projectId={project.id}
        state={state}
        rangeTrimmedVideoUrl={state.rangeTrimmedVideoUrl}
        clipPreviews={state.clipPreviews}
        autoPartsClipPreviews={state.autoPartsClipPreviews ?? state.clipPreviews}
        aiClipPreviews={state.aiClipPreviews ?? []}
        manualClipPreviews={state.manualClipPreviews ?? []}
        clipSourceMode={state.clipSourceMode ?? "auto-parts"}
        activeClipIndex={state.activeClipIndex}
        onSelectClip={setActiveClipIndex}
        onClipSourceModeChange={setClipSourceMode}
        onDeleteAiClip={deleteAiClip}
        onDeleteAutoPartsClip={deleteAutoPartsClip}
        onDeleteManualClip={deleteManualClip}
        onUpsertManualClip={upsertManualClip}
        settings={settings}
        onUpdateSettings={updateSettings}
        getFrameContext={getFrameContext}
        getRangeFrameContext={getRangeFrameContext}
        sourceFileName={state.sourceFileName}
        isRendering={isRendering}
        onOpenRenderQueue={renderQueue.openRenderQueue}
        disabledCollageRegionIds={disabledCollageRegionIds}
        onToggleCollageRegion={toggleCollageRegion}
        autoPartsSegmentLengthSec={autoPartsSegmentLengthSec}
        onAutoPartsSegmentLengthChange={(lengthSec) => {
          void resegmentAutoParts(lengthSec);
        }}
        onResetAutoParts={() => {
          void resegmentAutoParts(autoPartsSegmentLengthSec, { force: true });
        }}
        autoPartsResegmenting={autoPartsResegmenting}
        settingsDrawerVisible={settingsDrawerVisible}
        onFixFraming={openFramingEditor}
        onCheckFraming={checkFraming}
      />
      {framingReport ? (
        <ClipperFramingReport
          entries={framingReport}
          formatLabel={DEFAULT_FRAMING_FORMAT?.label ?? "the default format"}
          onClose={() => setFramingReport(null)}
          onFix={(clipIndex) => {
            setFramingReport(null);
            openFramingEditor(clipIndex);
          }}
          onAutoFixAll={async () => {
            if (!DEFAULT_FRAMING_FORMAT) return 0;
            let count = 0;
            for (const entry of framingReport) {
              const source = getClipEditorSourceForClip(entry.clipIndex, DEFAULT_FRAMING_FORMAT.id);
              const faces = source?.frameContext.faceCache?.sortedSamples();
              if (!source || !faces) continue;
              const plan = planFramingWithLearning(source.framingTrack, {
                aiShotBoundaries: source.aiShotBoundaries,
                faceSamples: faces,
                clipSegments: source.clip.segments,
                outputAspect: source.outputSize.width / Math.max(1, source.outputSize.height),
                duration: source.duration,
              });
              if (!plan.fixedShots.length) continue;
              await saveClipFramingTrack(source.clip, plan.track);
              count += plan.fixedShots.length;
            }
            return count;
          }}
        />
      ) : null}
      {framingEditor ? (
        <ClipperVideoEditor
          projectId={project.id}
          source={framingEditor.source}
          clipTitle={`Clip ${framingEditor.clipIndex + 1}`}
          formatOptions={FRAMING_FORMATS}
          onFormatChange={switchFramingFormat}
          onSaveFraming={(track) => saveClipFramingTrack(framingEditor.source.clip, track)}
          onClose={() => setFramingEditor(null)}
          onSaved={() => {}}
        />
      ) : null}
    </ClipperTranscriptEditProvider>
  );
};
