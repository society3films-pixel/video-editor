import React, { Suspense, lazy, useMemo, useState } from "react";
import { ClipperManualClipModal } from "./clipper-manual-clip-modal.component";
import {
  clipPayloadFromWordRanges,
  wordSpanForClip,
  type AiClipSegmentRange,
} from "../engine/transcript";
import {
  fetchClipperClips,
  saveClipperClips,
} from "../persistence/clipper-clips-api.util";
import { appToast } from "../../../shared/utils/toast.service";
import { ClipperAiPickPanel } from "./clipper-ai-pick-panel.component";
import { Box } from "@chakra-ui/react";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import {
  ClipperAiMcpEmptyState,
  ClipperAiMcpPanel,
} from "./clipper-ai-mcp-panel.component";
import { ClipperAutoPartsLengthIsland } from "./clipper-auto-parts-length-island.component";
import { ClipperClipSelector } from "./clipper-clip-selector.component";
import {
  AUTO_PARTS_LENGTH_OVERLAY_PAD,
  clipSelectorTranscriptProps,
  type ClipperClipsSectionProps,
} from "./clipper-clips-section.types";

const ClipperManualClipsSection = lazy(async () => {
  const mod = await import("./clipper-manual-clips-section.component");
  return { default: mod.ClipperManualClipsSection };
});

export const ClipperClipsSection: React.FC<ClipperClipsSectionProps> = ({
  projectId,
  onRenderAiClips,
  clipPreviews,
  autoPartsClipPreviews,
  aiClipPreviews,
  manualClipPreviews,
  clipSourceMode,
  activeClipIndex,
  onSelectClip,
  onDeleteAiClip,
  onDeleteAutoPartsClip,
  onDeleteManualClip,
  onUpsertManualClip,
  onOpenInStudio,
  openingInStudio = false,
  rangeWords,
  collageRegions,
  disabledCollageRegionIds,
  onToggleCollageRegion,
  onSeekToTranscriptTime,
  autoPartsSegmentLengthSec,
  onAutoPartsSegmentLengthChange,
  onResetAutoParts,
  autoPartsResegmenting = false,
  rangeTrimmedVideoUrl,
  getRangeFile,
  rangeDurationSec,
  getRangeFrameContext,
  onManualEditorOpen,
}) => {
  const { theme } = useClipperUi();
  // Changing an AI clip's start and end (exact times allowed, e.g. to keep a pause after the words).
  const [aiRangeEdit, setAiRangeEdit] = useState<number | null>(null);
  const aiInitialRange = useMemo(() => {
    if (aiRangeEdit == null) return null;
    const preview = (aiClipPreviews ?? []).find(
      (item) => item.clip.index === aiRangeEdit,
    );
    if (!preview) return null;
    const span = wordSpanForClip(preview.clip, rangeWords);
    return span
      ? {
          ...span,
          exactStartSec: preview.clip.startSec,
          exactEndSec: preview.clip.endSec,
        }
      : null;
  }, [aiClipPreviews, aiRangeEdit, rangeWords]);
  const saveAiRange = async (range: AiClipSegmentRange) => {
    if (aiRangeEdit == null) return;
    try {
      const clips = await fetchClipperClips(projectId, "ai");
      const current = clips.find((clip) => clip.index === aiRangeEdit);
      const payload = clipPayloadFromWordRanges(
        aiRangeEdit,
        [range],
        rangeWords,
        current?.label,
        rangeDurationSec,
      );
      if (!payload) return;
      await saveClipperClips(
        projectId,
        "ai",
        clips.map((clip) => (clip.index === aiRangeEdit ? payload : clip)),
      );
    } catch (error) {
      appToast.error(
        "Couldn't save the clip's range",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const isAiMode = clipSourceMode === "ai";
  const isManualMode = clipSourceMode === "manual";
  const safeAutoPartsPreviews = autoPartsClipPreviews ?? [];
  const safeAiPreviews = aiClipPreviews ?? [];
  const safeManualPreviews = manualClipPreviews ?? [];
  const safeClipPreviews = clipPreviews ?? safeAutoPartsPreviews;
  const listPreviews = isAiMode
    ? safeAiPreviews
    : isManualMode
      ? safeManualPreviews
      : safeAutoPartsPreviews;
  const transcriptProps = clipSelectorTranscriptProps(
    rangeWords,
    collageRegions,
    disabledCollageRegionIds,
    onToggleCollageRegion,
    onSeekToTranscriptTime,
  );

  if (!isAiMode && !isManualMode && safeAutoPartsPreviews.length === 0) {
    return null;
  }

  if (isManualMode) {
    return (
      <Suspense
        fallback={
          <Box
            flex="1"
            minH={0}
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Box fontSize="sm" color={theme.text.muted}>
              Loading manual clips…
            </Box>
          </Box>
        }
      >
        <ClipperManualClipsSection
          clipPreviews={safeManualPreviews}
          activeClipIndex={activeClipIndex}
          onSelectClip={onSelectClip}
          onDeleteManualClip={onDeleteManualClip}
          onUpsertManualClip={onUpsertManualClip}
          onOpenInStudio={onOpenInStudio}
          openingInStudio={openingInStudio}
          rangeWords={rangeWords}
          collageRegions={collageRegions}
          disabledCollageRegionIds={disabledCollageRegionIds}
          onToggleCollageRegion={onToggleCollageRegion}
          onSeekToTranscriptTime={onSeekToTranscriptTime}
          rangeTrimmedVideoUrl={rangeTrimmedVideoUrl}
          rangeDurationSec={rangeDurationSec}
          getRangeFrameContext={getRangeFrameContext}
          onManualEditorOpen={onManualEditorOpen}
        />
      </Suspense>
    );
  }

  return (
    <Box flex="1" minH={0} display="flex" flexDirection="column">
      {isAiMode ? (
        <Box
          flex="1"
          minH={0}
          overflow="hidden"
          display="flex"
          flexDirection="column"
        >
          {listPreviews.length > 0 ? (
            <Box
              flex="1"
              minH={0}
              overflow="hidden"
              display="flex"
              flexDirection="column"
            >
              <ClipperClipSelector
                clipPreviews={listPreviews}
                activeClipIndex={activeClipIndex}
                onSelectClip={onSelectClip}
                onDeleteClip={onDeleteAiClip}
                onEditClip={
                  rangeWords.length
                    ? (index) => {
                        const preview = listPreviews.find(
                          (item) => item.clip.index === index,
                        );
                        // Supercuts (several parts) are edited in the clip editor instead.
                        if (preview && preview.clip.segments.length > 1) {
                          appToast.info(
                            "This clip has several parts",
                            "Open it with Edit clip to change its parts.",
                          );
                          return;
                        }
                        setAiRangeEdit(index);
                      }
                    : undefined
                }
                onOpenInStudio={onOpenInStudio}
                openingInStudio={openingInStudio}
                hideTitle
                {...transcriptProps}
              />
            </Box>
          ) : (
            // No AI clips yet: the picker first, so it isn't below the fold.
            <Box flex="1" minH={0} overflowY="auto">
              <ClipperAiPickPanel
                projectId={projectId}
                rangeWords={rangeWords ?? []}
                getRangeFile={getRangeFile}
                onRenderAll={onRenderAiClips}
              />
              <ClipperAiMcpEmptyState />
            </Box>
          )}

          {listPreviews.length > 0 ? (
            <ClipperAiPickPanel
              projectId={projectId}
              rangeWords={rangeWords ?? []}
              getRangeFile={getRangeFile}
              onRenderAll={onRenderAiClips}
            />
          ) : null}
          <ClipperAiMcpPanel
            clipCount={listPreviews.length}
            projectId={projectId}
          />
          <ClipperManualClipModal
            isOpen={aiRangeEdit != null}
            onClose={() => setAiRangeEdit(null)}
            onSave={(range) => void saveAiRange(range)}
            words={rangeWords}
            durationSec={Math.max(
              rangeDurationSec ?? 0,
              rangeWords.at(-1)?.end ?? 0,
            )}
            videoUrl={rangeTrimmedVideoUrl ?? null}
            initialRange={aiInitialRange}
            getRangeFrameContext={getRangeFrameContext}
            mode="edit"
          />
        </Box>
      ) : (
        <Box
          position="relative"
          flex="1"
          minH={0}
          overflow="hidden"
          display="flex"
          flexDirection="column"
        >
          <ClipperClipSelector
            clipPreviews={safeClipPreviews}
            activeClipIndex={activeClipIndex}
            onSelectClip={onSelectClip}
            onDeleteClip={onDeleteAutoPartsClip}
            onOpenInStudio={onOpenInStudio}
            openingInStudio={openingInStudio}
            hideTitle
            bottomInset={AUTO_PARTS_LENGTH_OVERLAY_PAD}
            {...transcriptProps}
          />

          <Box
            position="absolute"
            bottom={0}
            left={0}
            right={0}
            zIndex={2}
            pointerEvents="none"
          >
            <ClipperAutoPartsLengthIsland
              value={autoPartsSegmentLengthSec}
              onChange={onAutoPartsSegmentLengthChange}
              onReset={onResetAutoParts}
              disabled={autoPartsResegmenting}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
};
