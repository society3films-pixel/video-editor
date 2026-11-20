import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadTemplates, type EditTemplate } from "../editor/edit-templates.util";
import { renderClipsWithLook } from "../editor/render-with-look.util";
import { appToast } from "../../../shared/utils/toast.service";
import { Box, Center, Text } from "@chakra-ui/react";
import { checkClipFraming, FRAMING_ISSUE_LABEL } from "../editor/framing-check.util";
import { getClipperFormatDef } from "../shared/formats.util";
import { useWatchFolderAutomation } from "../hooks/use-watch-folder-automation.hook";
import { ClipperLayout } from "../components/clipper-layout.component";
import { ClipperExportsView } from "../components/clipper-exports-view.component";
import { ClipperRenderQueue } from "../components/clipper-render-queue.component";
import { ClipperRenderQueueSetup } from "../components/clipper-render-queue-setup.component";
import { ClipperProcessing } from "../components/clipper-processing.component";
import { ClipperProjectLoadingPanel } from "../components/clipper-project-loading-panel.component";
import { ClipperTrimSelect } from "../components/clipper-trim-select.component";
import { ClipperUpload } from "../components/clipper-upload.component";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { ClipperSessionPreviewPanel } from "../components/session/clipper-session-preview-panel.component";
import { useClipperSessionView } from "../hooks/use-clipper-session-view.hook";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import type { ClipperSessionViewProps } from "../shared/clipper-session-view.types";

export type { ClipperSessionViewProps } from "../shared/clipper-session-view.types";

export function ClipperSessionView({ project, token, loaded }: ClipperSessionViewProps) {
  // Looks for the render queue (built-in trending looks and saved templates).
  const [looks, setLooks] = useState<EditTemplate[]>([]);
  const [lookId, setLookId] = useState<string>(() => {
    try {
      return localStorage.getItem("openclipper.renderQueue.look") ?? "";
    } catch {
      return "";
    }
  });
  const [lookProgress, setLookProgress] = useState<{ label: string; done: number; total: number; ratio: number } | null>(null);
  const lookAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    void loadTemplates().then(setLooks).catch(() => {});
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("openclipper.renderQueue.look", lookId);
    } catch {
      // Not remembered; fine.
    }
  }, [lookId]);
  const { theme, errorPanel } = useClipperUi();
  const session = useClipperSessionView({ project, token, loaded });
  useWatchFolderAutomation(project.id, session);
  const {
    state,
    settings,
    updateSettings,
    confirmRange,
    refreshExportHistory,
    getClipEditorSource,
    saveClipFramingTrack,
    reset,
    sourceUrl,
    rangeLocked,
    retryResume,
    handleFile,
    handleOpenExportsFolder,
    step,
    visibility,
    resumeLoadingStatus,
    isRendering,
    exportCount,
    sessionResults,
    renderQueue,
    existingExports,
    goToExports,
    stopRender,
  } = session;
  // Framing check for the render queue: warnings only, in the vertical format (the one most clips are made for).
  const framingWarnings = useMemo(() => {
    const warnings = new Map<number, string[]>();
    if (!visibility.showQueueSetup) return warnings;
    const formatId = getClipperFormatDef("vertical-short")?.id ?? settings.formats.enabledFormatIds[0];
    if (!formatId) return warnings;
    for (const preview of state.clipPreviews) {
      const source = session.getClipEditorSourceForClip(preview.clip.index, formatId);
      if (!source) continue;
      const issues = checkClipFraming(source).filter((issue) => issue.severity === "warning");
      if (issues.length) warnings.set(preview.clip.index, issues.map((issue) => `Shot ${issue.shotIndex + 1}: ${FRAMING_ISSUE_LABEL[issue.kind]}`));
    }
    return warnings;
  }, [state.clipPreviews, visibility.showQueueSetup, session.clipFramingRevision]);

  const renderWithLook = async (look: EditTemplate) => {
    const controller = new AbortController();
    lookAbortRef.current = controller;
    setLookProgress({ label: "Starting", done: 0, total: 1, ratio: 0 });
    try {
      const outcome = await renderClipsWithLook(
        project.id,
        look,
        renderQueue.formatIdsByClip,
        (clipIndex, formatId) => session.getClipEditorSourceForClip(clipIndex, formatId),
        { signal: controller.signal, onProgress: (done, total, label, ratio) => setLookProgress({ done, total, label, ratio }) },
      );
      refreshExportHistory();
      if (outcome.saved) {
        appToast.success(
          `Rendered ${outcome.saved} with “${look.name}”`,
          outcome.failed.length ? `Not rendered: ${outcome.failed.join("; ")}` : "They're in Your exports.",
        );
        goToExports();
      } else {
        appToast.error("Nothing was rendered", outcome.failed.join("; ") || "No clips or formats were selected.");
      }
    } catch (error) {
      if (!controller.signal.aborted) appToast.error("Render stopped", error instanceof Error ? error.message : String(error));
      else refreshExportHistory();
    } finally {
      lookAbortRef.current = null;
      setLookProgress(null);
    }
  };

  return (
    <ClipperLayout
      step={visibility.showRestoreLoader ? undefined : step}
      backLink={visibility.layoutBackLink}
    >
      {visibility.showUpload && <ClipperUpload onFile={handleFile} fill />}

      {state.stage === "trimming" && sourceUrl && !rangeLocked && (
        <ClipperTrimSelect
          sourceUrl={sourceUrl}
          sourceDuration={state.sourceDuration ?? 60}
          initialStartSec={state.clipStart > 0 ? state.clipStart : undefined}
          initialEndSec={state.clipEnd ?? state.sourceDuration ?? undefined}
          sourceFileName={state.sourceFileName}
          onConfirm={(start, end) => {
            void confirmRange(start, end);
          }}
          onCancel={reset}
        />
      )}

      {visibility.showRestoreLoader && (
        <Center py={12}>
          <ClipperProjectLoadingPanel status={resumeLoadingStatus} />
        </Center>
      )}

      {visibility.showFreshProcessing && (
        <Center py={12}>
          <Box maxW="560px" w="full">
            <ClipperProcessing state={state} />
          </Box>
        </Center>
      )}

      {visibility.previewKeepAlive && (
        <Box display={visibility.showPreview ? undefined : "none"} w="full" h="full">
          <ClipperSessionPreviewPanel
            session={session}
            settingsDrawerVisible={visibility.showPreview}
          />
        </Box>
      )}

      {visibility.showQueueSetup && (
        <>
          {state.error ? (
            <Box mb={4} p={4} borderRadius="xl" {...errorPanel}>
              <Text color={theme.status.danger} fontSize="sm">
                {state.error}
              </Text>
            </Box>
          ) : null}
          <ClipperRenderQueueSetup
          clipPreviews={state.clipPreviews}
          rangeTrimmedVideoUrl={state.rangeTrimmedVideoUrl!}
          formats={settings.formats}
          onChangeFormats={(patch) =>
            updateSettings((prev) => ({ ...prev, formats: { ...prev.formats, ...patch } }))
          }
          getClipFormatIds={renderQueue.getClipFormatIds}
          onToggleClipFormat={renderQueue.toggleClipFormat}
          onSetFormatForAll={renderQueue.setFormatForAllClips}
          onSetAllFormatsForClip={renderQueue.setAllFormatsForClip}
          isRendering={isRendering}
          existingExports={existingExports}
          onRender={() => {
            const look = looks.find((item) => item.id === lookId);
            if (look) void renderWithLook(look);
            else renderQueue.startQueuedRender({ skipExisting: settings.formats.skipExisting });
          }}
          looks={looks}
          lookId={lookId}
          onLookChange={setLookId}
          lookProgress={lookProgress}
          onStopLook={() => lookAbortRef.current?.abort()}
          exportCount={exportCount}
          onViewExports={goToExports}
          framingWarnings={framingWarnings}
        />
        </>
      )}

      {visibility.showQueueProgress && (
        <>
          {state.error ? (
            <Box mb={4} p={4} borderRadius="xl" {...errorPanel}>
              <Text color={theme.status.danger} fontSize="sm">
                {state.error}
              </Text>
            </Box>
          ) : null}
          <ClipperRenderQueue
          state={state}
          clipPreviews={state.clipPreviews}
          formatIdsByClip={renderQueue.formatIdsByClip}
          results={sessionResults}
          isRendering={isRendering}
          sourceFileName={state.sourceFileName}
          projectId={project.id}
          onOpenFolder={handleOpenExportsFolder}
          onStop={stopRender}
          onContinue={() =>
            renderQueue.startQueuedRender({ skipCompleted: true, skipExisting: true })
          }
          onRestart={() => renderQueue.startQueuedRender({ restart: true })}
        />
        </>
      )}

      {visibility.showExports && (
        <ClipperExportsView
          exportHistory={state.exportHistory}
          sourceFileName={state.sourceFileName}
          projectId={project.id}
          onRefreshHistory={refreshExportHistory}
          editorBridge={{ getSource: getClipEditorSource, saveFraming: saveClipFramingTrack }}
        />
      )}

      {state.stage === "error" && (
        <Box p={6} borderRadius="2xl" {...errorPanel}>
          <Text color={theme.status.danger} fontWeight="semibold" mb={2}>
            Something went wrong
          </Text>
          <Text color={theme.text.muted} mb={4}>
            {state.error}
          </Text>
          {rangeLocked && (
            <Box mb={4}>
              <OutlinedActionButton onClick={retryResume}>
                Resume this step
              </OutlinedActionButton>
            </Box>
          )}
          <ClipperUpload onFile={handleFile} />
        </Box>
      )}
    </ClipperLayout>
  );
}
