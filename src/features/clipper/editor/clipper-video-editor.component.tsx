import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Button, Flex, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Pause, Play, RotateCcw, Scissors, Trash2, Undo2, X } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { appToast } from "../../../shared/utils/toast.service";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { ClipperFormatResult } from "../shared/state.util";
import {
  createInitialClipEdit,
  createTextOverlay,
  findNextSegment,
  findSegmentAt,
  formatEditorTime,
  getFadeFactor,
  getOutputDuration,
  isClipEditUnchanged,
  removeClipEditSegment,
  resetClipEditCuts,
  sourceToOutputTime,
  splitClipEditAt,
  trimClipEditSegment,
  type ClipEdit,
} from "./clip-edit.util";
import { drawClipEditOverlays } from "./clip-edit-draw.util";
import { ClipperEditorTimeline } from "./clipper-editor-timeline.component";
import { ClipperEditorSidePanel } from "./clipper-editor-side-panel.component";
import { saveEditedClipperExport } from "./save-edited-export.util";

interface ClipperVideoEditorProps {
  result: ClipperFormatResult;
  projectId: string;
  onClose: () => void;
  /** Called after the edited copy has been written and registered. */
  onSaved: () => void;
}

/** Text edits within this window collapse into one undo step. */
const HISTORY_COALESCE_MS = 600;
const HISTORY_LIMIT = 100;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Basic editor for a finished export (already captioned and reframed): cut and trim parts,
 * adjust volume, add fades and text, then save as a new export alongside the original.
 */
export const ClipperVideoEditor: React.FC<ClipperVideoEditorProps> = ({
  result,
  projectId,
  onClose,
  onSaved,
}) => {
  const { theme, scrollbarCss } = useClipperUi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [duration, setDuration] = useState(0);
  const [edit, setEdit] = useState<ClipEdit | null>(null);
  const [history, setHistory] = useState<ClipEdit[]>([]);
  const lastHistoryPushRef = useRef(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const editRef = useRef(edit);
  editRef.current = edit;

  const outputDuration = edit ? getOutputDuration(edit.segments) : 0;
  const outputTime = edit ? sourceToOutputTime(edit.segments, currentTime) : 0;
  const dirty = edit ? !isClipEditUnchanged(edit, duration) : false;

  // ---- Edit + history -------------------------------------------------------------------------

  const pushHistory = useCallback((snapshot: ClipEdit, coalesce: boolean) => {
    const now = Date.now();
    if (coalesce && now - lastHistoryPushRef.current < HISTORY_COALESCE_MS) {
      lastHistoryPushRef.current = now;
      return;
    }
    lastHistoryPushRef.current = now;
    setHistory((items) => [...items.slice(-(HISTORY_LIMIT - 1)), snapshot]);
  }, []);

  const applyEdit = useCallback(
    (updater: (current: ClipEdit) => ClipEdit, options: { coalesce?: boolean; record?: boolean } = {}) => {
      const current = editRef.current;
      if (!current) return;
      const next = updater(current);
      if (next === current) return;
      if (options.record !== false) pushHistory(current, options.coalesce ?? false);
      setEdit(next);
    },
    [pushHistory],
  );

  const historyRef = useRef(history);
  historyRef.current = history;

  const undo = useCallback(() => {
    const items = historyRef.current;
    const previous = items[items.length - 1];
    if (!previous) return;
    lastHistoryPushRef.current = 0;
    setEdit(previous);
    setHistory(items.slice(0, -1));
  }, []);

  // ---- Playback -------------------------------------------------------------------------------

  const seek = useCallback(
    (sourceTime: number) => {
      const video = videoRef.current;
      const clamped = Math.min(Math.max(0, sourceTime), duration || 0);
      if (video) video.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    const current = editRef.current;
    if (!video || !current) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if (!findSegmentAt(current.segments, video.currentTime)) {
      const next = findNextSegment(current.segments, video.currentTime) ?? current.segments[0];
      if (next) video.currentTime = next.start;
    }
    void video.play().catch(() => {});
  }, []);

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const current = editRef.current;
    const video = videoRef.current;
    if (!canvas || !current || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const total = getOutputDuration(current.segments);
    const inCut = !findSegmentAt(current.segments, video.currentTime);
    if (inCut) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const t = sourceToOutputTime(current.segments, video.currentTime);
    drawClipEditOverlays(ctx, current, t, total, canvas.width, canvas.height);
  }, []);

  // Skip over cut regions while playing and keep the preview volume in sync with the edit.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      const current = editRef.current;
      if (video && current) {
        if (!video.paused) {
          const t = video.currentTime;
          if (!findSegmentAt(current.segments, t)) {
            const next = findNextSegment(current.segments, t);
            if (next) {
              video.currentTime = next.start;
            } else {
              video.pause();
              video.currentTime = current.segments[0]?.start ?? 0;
            }
          }
        }
        const total = getOutputDuration(current.segments);
        const out = sourceToOutputTime(current.segments, video.currentTime);
        const gain = current.volume * getFadeFactor(current, out, total);
        video.muted = gain <= 0;
        video.volume = Math.min(1, Math.max(0, gain));
        setCurrentTime(video.currentTime);
        drawOverlay();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [drawOverlay]);

  useEffect(() => {
    drawOverlay();
  }, [edit, drawOverlay]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video) return;
    const d = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : Math.max(0, (result.clipEndSec ?? 0) - (result.clipStartSec ?? 0));
    if (canvas) {
      canvas.width = video.videoWidth || result.width;
      canvas.height = video.videoHeight || result.height;
    }
    setDuration(d);
    setEdit((current) => current ?? createInitialClipEdit(d));
  }, [result]);

  // ---- Editing actions ------------------------------------------------------------------------

  const splitAtPlayhead = useCallback(() => {
    applyEdit((current) => splitClipEditAt(current, videoRef.current?.currentTime ?? currentTime));
  }, [applyEdit, currentTime]);

  const deleteSelected = useCallback(() => {
    const current = editRef.current;
    if (!current) return;
    const target =
      current.segments.find((segment) => segment.id === selectedSegmentId) ??
      findSegmentAt(current.segments, videoRef.current?.currentTime ?? 0);
    if (!target) return;
    if (current.segments.length <= 1) {
      appToast.info("Can't delete the only part", "Split the clip first, then delete the part you don't want.");
      return;
    }
    applyEdit((value) => removeClipEditSegment(value, target.id));
    setSelectedSegmentId(null);
  }, [applyEdit, selectedSegmentId]);

  const addText = useCallback(() => {
    applyEdit((current) => ({
      ...current,
      textOverlays: [...current.textOverlays, createTextOverlay(outputTime, getOutputDuration(current.segments))],
    }));
  }, [applyEdit, outputTime]);

  const handleTrimStart = useCallback(() => {
    const current = editRef.current;
    if (current) pushHistory(current, false);
  }, [pushHistory]);

  const handleTrim = useCallback(
    (segmentId: string, edge: "start" | "end", sourceTime: number) => {
      applyEdit((current) => trimClipEditSegment(current, segmentId, edge, sourceTime, duration), { record: false });
    },
    [applyEdit, duration],
  );

  // ---- Save / close ---------------------------------------------------------------------------

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty && !window.confirm("Discard your edits?")) return;
    onClose();
  }, [dirty, onClose, saving]);

  const save = useCallback(async () => {
    const current = editRef.current;
    if (!current || saving) return;
    videoRef.current?.pause();
    const controller = new AbortController();
    abortRef.current = controller;
    setSaving(true);
    setSaveProgress(0);
    try {
      const outcome = await saveEditedClipperExport(projectId, result, current, {
        signal: controller.signal,
        onProgress: setSaveProgress,
      });
      appToast.success(
        outcome.kind === "saved" ? "Edited clip saved" : "Edited clip downloaded",
        outcome.kind === "saved"
          ? `${outcome.fileName} was added to your exports. The original is unchanged.`
          : outcome.fileName,
      );
      onSaved();
      onClose();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        appToast.info("Save cancelled");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        appToast.error("Could not save the edited clip", message);
      }
    } finally {
      abortRef.current = null;
      setSaving(false);
    }
  }, [onClose, onSaved, projectId, result, saving]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ---- Keyboard + scroll lock -----------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (saving) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key.toLowerCase() === "s" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        splitAtPlayhead();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? 1 : 1 / 30;
        const video = videoRef.current;
        video?.pause();
        seek((video?.currentTime ?? 0) + (event.key === "ArrowLeft" ? -step : step));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [deleteSelected, requestClose, saving, seek, splitAtPlayhead, togglePlay, undo]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const aspectRatio = useMemo(() => `${result.width} / ${result.height}`, [result.width, result.height]);

  const toolButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    options: { disabled?: boolean; shortcut?: string } = {},
  ) => (
    <OutlinedActionButton
      startIcon={icon}
      onClick={onClick}
      disabled={options.disabled || saving || !edit}
      title={options.shortcut ? `${label} (${options.shortcut})` : label}
      h="32px"
      px={3}
      fontSize="xs"
    >
      {label}
    </OutlinedActionButton>
  );

  return createPortal(
    <Flex
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${result.label}`}
      position="fixed"
      inset={0}
      zIndex={2000}
      direction="column"
      bg={theme.background.primary}
      color={theme.text.primary}
    >
      <HStack
        justify="space-between"
        px={5}
        py={3}
        borderBottom="1px solid"
        borderColor={theme.surface.hover}
        flexShrink={0}
      >
        <VStack align="start" gap={0} minW={0}>
          <Text fontSize="md" fontWeight="bold" lineClamp={1}>
            Edit clip {result.clipIndex + 1} · {result.label}
          </Text>
          <Text fontSize="xs" color={theme.text.muted}>
            Saves a new export. The original stays as it is.
          </Text>
        </VStack>
        <HStack gap={2}>
          <OutlinedActionButton onClick={requestClose} disabled={saving} startIcon={<X size={16} />}>
            Close
          </OutlinedActionButton>
          <Button
            onClick={() => void save()}
            disabled={!edit || !dirty || saving || outputDuration <= 0}
            bg={clipperTheme.accent}
            color="white"
            h="36px"
            px={5}
            borderRadius="md"
            fontWeight="semibold"
            _hover={{ bg: clipperTheme.accentHover }}
          >
            {saving ? (
              <HStack gap={2}>
                <Spinner size="xs" />
                <Text>Saving {Math.round(saveProgress * 100)}%</Text>
              </HStack>
            ) : (
              "Save as new export"
            )}
          </Button>
          {saving ? (
            <OutlinedActionButton tone="danger" onClick={() => abortRef.current?.abort()}>
              Cancel
            </OutlinedActionButton>
          ) : null}
        </HStack>
      </HStack>

      <Flex flex={1} minH={0} direction={{ base: "column", lg: "row" }}>
        <Flex flex={1} minW={0} minH={0} direction="column" p={4} gap={3}>
          <Flex flex={1} minH={0} align="center" justify="center" bg="black" borderRadius="lg" overflow="hidden" p={2}>
            <Box
              position="relative"
              style={{ aspectRatio }}
              maxH="100%"
              maxW="100%"
              h="100%"
              onClick={togglePlay}
              cursor="pointer"
            >
              <video
                ref={videoRef}
                src={result.previewUrl}
                playsInline
                preload="auto"
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setLoadError("This export could not be loaded for editing.")}
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
              />
              <canvas
                ref={canvasRef}
                width={result.width}
                height={result.height}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
              />
              {!edit && !loadError ? (
                <Flex position="absolute" inset={0} align="center" justify="center">
                  <Spinner color="white" />
                </Flex>
              ) : null}
              {loadError ? (
                <Flex position="absolute" inset={0} align="center" justify="center" p={4}>
                  <Text color="white" fontSize="sm" textAlign="center">
                    {loadError}
                  </Text>
                </Flex>
              ) : null}
            </Box>
          </Flex>

          <HStack gap={2} flexWrap="wrap" flexShrink={0}>
            <Flex
              as="button"
              aria-label={playing ? "Pause" : "Play"}
              onClick={togglePlay}
              w="36px"
              h="36px"
              align="center"
              justify="center"
              borderRadius="full"
              bg={clipperTheme.accent}
              color="white"
              cursor="pointer"
              flexShrink={0}
            >
              {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />}
            </Flex>
            <Text fontSize="sm" fontFamily="mono" minW="120px">
              {formatEditorTime(outputTime)} / {formatEditorTime(outputDuration)}
            </Text>
            <Box flex={1} />
            {toolButton("Split", <Scissors size={14} />, splitAtPlayhead, { shortcut: "S" })}
            {toolButton("Delete part", <Trash2 size={14} />, deleteSelected, {
              shortcut: "Del",
              disabled: (edit?.segments.length ?? 0) <= 1,
            })}
            {toolButton("Undo", <Undo2 size={14} />, undo, { shortcut: "Ctrl+Z", disabled: history.length === 0 })}
            {toolButton(
              "Reset cuts",
              <RotateCcw size={14} />,
              () => applyEdit((current) => resetClipEditCuts(current, duration)),
              { disabled: (edit?.segments.length ?? 0) === 1 && edit?.segments[0]?.start === 0 && edit?.segments[0]?.end === duration },
            )}
          </HStack>

          {edit && duration > 0 ? (
            <Box flexShrink={0}>
              <ClipperEditorTimeline
                duration={duration}
                segments={edit.segments}
                selectedSegmentId={selectedSegmentId}
                currentTime={currentTime}
                onSeek={seek}
                onSelectSegment={setSelectedSegmentId}
                onTrimStart={handleTrimStart}
                onTrim={handleTrim}
              />
              <Text fontSize="xs" color={theme.text.muted} mt={2}>
                Drag the edges of a part to trim it. Move the playhead and press Split (S) to cut, then select a part
                and Delete it. Striped areas are removed from the saved clip.
              </Text>
            </Box>
          ) : null}
        </Flex>

        <Box
          w={{ base: "full", lg: "340px" }}
          flexShrink={0}
          borderLeft={{ lg: "1px solid" }}
          borderTop={{ base: "1px solid", lg: "none" }}
          borderColor={theme.surface.hover}
          p={4}
          overflowY="auto"
          css={scrollbarCss}
          maxH={{ base: "45vh", lg: "none" }}
        >
          {edit ? (
            <ClipperEditorSidePanel
              edit={edit}
              outputDuration={outputDuration}
              outputTime={outputTime}
              onChange={(updater) => applyEdit(updater, { coalesce: true })}
              onAddText={addText}
            />
          ) : null}
        </Box>
      </Flex>
    </Flex>,
    document.body,
  );
};
