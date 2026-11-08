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
  createDefaultSegmentFraming,
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
  setCaptionGroupText,
  sourceToOutputTime,
  splitClipEditAt,
  trimClipEditSegment,
  type ClipEdit,
  type ClipSegmentFraming,
} from "./clip-edit.util";
import { applyEditToFrameContext, type ClipEditorSource } from "./clip-editor-source.util";
import {
  createEditorTimeMap,
  dragFraming,
  drawEditorPreviewFrame,
  lockedFramingFromAi,
  previewCanvasSize,
} from "./clip-editor-preview.util";
import { ClipperEditorTimeline } from "./clipper-editor-timeline.component";
import { ClipperEditorSidePanel } from "./clipper-editor-side-panel.component";
import { ClipperEditorCaptionsPanel, ClipperEditorFramingPanel } from "./clipper-editor-source-panels.component";
import { saveEditedClipperExport } from "./save-edited-export.util";

interface ClipperVideoEditorProps {
  result: ClipperFormatResult;
  projectId: string;
  /**
   * The project's source video and render context for this clip. When present, captions and
   * framing can be edited (the clip is re-rendered from the source on save).
   */
  source?: ClipEditorSource | null;
  onClose: () => void;
  /** Called after the edited copy has been written and registered. */
  onSaved: () => void;
}

/** Text edits within this window collapse into one undo step. */
const HISTORY_COALESCE_MS = 600;
const HISTORY_LIMIT = 100;
const DRAG_THRESHOLD_PX = 4;

type PanelTab = "edit" | "captions" | "framing";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Editor for a finished export: cut and trim parts, adjust volume, add fades and text, and,
 * when the project's source video is loaded, change caption wording and framing. Saves as a
 * new export alongside the original.
 */
export const ClipperVideoEditor: React.FC<ClipperVideoEditorProps> = ({
  result,
  projectId,
  source = null,
  onClose,
  onSaved,
}) => {
  const { theme, scrollbarCss } = useClipperUi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const outputWidth = source?.outputSize.width ?? result.width;
  const outputHeight = source?.outputSize.height ?? result.height;
  const canvasSize = useMemo(
    () => previewCanvasSize({ width: outputWidth, height: outputHeight }),
    [outputWidth, outputHeight],
  );

  const [duration, setDuration] = useState(source?.duration ?? 0);
  const [edit, setEdit] = useState<ClipEdit | null>(() => (source ? createInitialClipEdit(source.duration) : null));
  const [history, setHistory] = useState<ClipEdit[]>([]);
  const lastHistoryPushRef = useRef(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("edit");
  const abortRef = useRef<AbortController | null>(null);

  const editRef = useRef(edit);
  editRef.current = edit;
  const timeMap = useMemo(() => createEditorTimeMap(source, duration), [source, duration]);
  const timeMapRef = useRef(timeMap);
  timeMapRef.current = timeMap;

  const previewContext = useMemo(
    () => (source && edit ? applyEditToFrameContext(source.frameContext, edit) : null),
    [source, edit],
  );
  const previewContextRef = useRef(previewContext);
  previewContextRef.current = previewContext;

  const outputDuration = edit ? getOutputDuration(edit.segments) : 0;
  const outputTime = edit ? sourceToOutputTime(edit.segments, currentTime) : 0;
  const dirty = edit ? !isClipEditUnchanged(edit, duration) : false;
  const playheadSegment = edit ? findSegmentAt(edit.segments, currentTime) ?? null : null;
  const framingSegment =
    (edit?.segments.find((segment) => segment.id === selectedSegmentId) ?? playheadSegment) || null;

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
      editRef.current = next;
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

  /** Seeks to a clip-local time. */
  const seek = useCallback(
    (localTime: number) => {
      const video = videoRef.current;
      const clamped = Math.min(Math.max(0, localTime), duration || 0);
      if (video) video.currentTime = timeMapRef.current.toVideo(clamped);
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
    const map = timeMapRef.current;
    const local = map.toLocal(video.currentTime);
    if (map.isPastEnd(video.currentTime) || !findSegmentAt(current.segments, local)) {
      const next =
        (map.isPastEnd(video.currentTime) ? undefined : findNextSegment(current.segments, local)) ??
        current.segments[0];
      if (next) video.currentTime = map.toVideo(next.start);
    }
    void video.play().catch(() => {});
  }, []);

  // One loop drives playback rules (skip gaps and cuts), preview volume and canvas drawing.
  useEffect(() => {
    let frame = 0;
    let lastDrawn = { time: -1, edit: null as ClipEdit | null, context: null as unknown };
    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const current = editRef.current;
      const map = timeMapRef.current;
      if (video && current) {
        if (!video.paused) {
          const gap = map.gapJump(video.currentTime);
          if (gap !== null) video.currentTime = gap;
          const local = map.toLocal(video.currentTime);
          if (map.isPastEnd(video.currentTime)) {
            video.pause();
            video.currentTime = map.toVideo(current.segments[0]?.start ?? 0);
          } else if (!findSegmentAt(current.segments, local)) {
            const next = findNextSegment(current.segments, local);
            if (next) {
              video.currentTime = map.toVideo(next.start);
            } else {
              video.pause();
              video.currentTime = map.toVideo(current.segments[0]?.start ?? 0);
            }
          }
        }
        const local = map.toLocal(video.currentTime);
        const total = getOutputDuration(current.segments);
        const gain = current.volume * getFadeFactor(current, sourceToOutputTime(current.segments, local), total);
        video.muted = gain <= 0;
        video.volume = Math.min(1, Math.max(0, gain));
        setCurrentTime(local);

        const context = previewContextRef.current;
        const ctx = canvas?.getContext("2d");
        const changed =
          !video.paused || video.seeking || lastDrawn.time !== video.currentTime || lastDrawn.edit !== current || lastDrawn.context !== context;
        if (ctx && canvas && changed) {
          drawEditorPreviewFrame(ctx, video, { width: canvas.width, height: canvas.height }, current, local, source, context);
          lastDrawn = { time: video.seeking ? -1 : video.currentTime, edit: current, context };
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [source]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (source) {
      video.currentTime = source.clip.segments[0]!.startSec;
      return;
    }
    const d = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : Math.max(0, (result.clipEndSec ?? 0) - (result.clipStartSec ?? 0));
    setDuration(d);
    setEdit((current) => current ?? createInitialClipEdit(d));
  }, [result, source]);

  // ---- Editing actions ------------------------------------------------------------------------

  const splitAtPlayhead = useCallback(() => {
    const video = videoRef.current;
    const local = video ? timeMapRef.current.toLocal(video.currentTime) : currentTime;
    applyEdit((current) => splitClipEditAt(current, local));
  }, [applyEdit, currentTime]);

  const deleteSelected = useCallback(() => {
    const current = editRef.current;
    if (!current) return;
    const video = videoRef.current;
    const local = video ? timeMapRef.current.toLocal(video.currentTime) : 0;
    const target =
      current.segments.find((segment) => segment.id === selectedSegmentId) ?? findSegmentAt(current.segments, local);
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
    (segmentId: string, edge: "start" | "end", localTime: number) => {
      applyEdit((current) => trimClipEditSegment(current, segmentId, edge, localTime, duration), { record: false });
    },
    [applyEdit, duration],
  );

  // ---- Captions + framing ---------------------------------------------------------------------

  const captionGroups = edit?.captionGroups ?? source?.frameContext.captionGroups ?? [];
  const captionsVisible = edit?.captionsVisible ?? source?.frameContext.settings.captions.enabled ?? false;

  const changeCaption = useCallback(
    (index: number, text: string) => {
      applyEdit(
        (current) => ({
          ...current,
          captionGroups: setCaptionGroupText(current.captionGroups ?? source?.frameContext.captionGroups ?? [], index, text),
        }),
        { coalesce: true },
      );
    },
    [applyEdit, source],
  );

  const setSegmentFraming = useCallback(
    (segmentId: string, framing: ClipSegmentFraming | undefined, coalesce = true) => {
      applyEdit(
        (current) => ({
          ...current,
          segments: current.segments.map((segment) => (segment.id === segmentId ? { ...segment, framing } : segment)),
        }),
        { coalesce },
      );
    },
    [applyEdit],
  );

  const lockFraming = useCallback(() => {
    const video = videoRef.current;
    if (!source || !framingSegment || !video || !video.videoWidth) return;
    const videoTime = timeMapRef.current.toVideo(
      Math.min(Math.max(currentTime, framingSegment.start), framingSegment.end - 0.01),
    );
    const next = lockedFramingFromAi(
      source,
      source.frameContext,
      { width: video.videoWidth, height: video.videoHeight },
      videoTime,
      framingSegment.framing ?? createDefaultSegmentFraming(),
    );
    setSegmentFraming(framingSegment.id, next, false);
  }, [currentTime, framingSegment, setSegmentFraming, source]);

  const applyFramingToAll = useCallback(() => {
    if (!framingSegment) return;
    const framing = framingSegment.framing;
    applyEdit((current) => ({
      ...current,
      segments: current.segments.map((segment) => ({ ...segment, framing })),
    }));
  }, [applyEdit, framingSegment]);

  /** Click toggles playback; dragging (on the Framing tab) repositions the camera. */
  const handlePreviewPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const canvas = event.currentTarget;
      const video = videoRef.current;
      const canDrag = Boolean(source && tab === "framing" && framingSegment && video?.videoWidth);
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(1, rect.width);
      const scaleY = canvas.height / Math.max(1, rect.height);
      const segmentId = framingSegment?.id ?? null;
      const startFraming = framingSegment?.framing ?? createDefaultSegmentFraming();
      let dragging = false;
      canvas.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!canDrag || !segmentId || !video) return;
        if (!dragging) {
          const current = editRef.current;
          if (current) pushHistory(current, false);
          dragging = true;
        }
        const next = dragFraming(
          startFraming,
          dx * scaleX,
          dy * scaleY,
          { width: canvas.width, height: canvas.height },
          { width: video.videoWidth, height: video.videoHeight },
        );
        applyEdit(
          (current) => ({
            ...current,
            segments: current.segments.map((segment) => (segment.id === segmentId ? { ...segment, framing: next } : segment)),
          }),
          { record: false },
        );
      };
      const onUp = () => {
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onUp);
        if (!dragging) togglePlay();
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointercancel", onUp);
    },
    [applyEdit, framingSegment, pushHistory, source, tab, togglePlay],
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
      const outcome = await saveEditedClipperExport(projectId, result, current, duration, {
        signal: controller.signal,
        onProgress: setSaveProgress,
        source,
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
      if ((error instanceof DOMException || error instanceof Error) && error.name === "AbortError") {
        appToast.info("Save cancelled");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        appToast.error("Could not save the edited clip", message);
      }
    } finally {
      abortRef.current = null;
      setSaving(false);
    }
  }, [duration, onClose, onSaved, projectId, result, saving, source]);

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
        const local = video ? timeMapRef.current.toLocal(video.currentTime) : 0;
        seek(local + (event.key === "ArrowLeft" ? -step : step));
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

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "edit", label: "Edit" },
    { id: "captions", label: "Captions" },
    { id: "framing", label: "Framing" },
  ];
  const segmentIndex = framingSegment && edit ? edit.segments.findIndex((s) => s.id === framingSegment.id) : -1;
  const hasCuts = (edit?.segments.length ?? 0) !== 1 || edit?.segments[0]?.start !== 0 || edit?.segments[0]?.end !== duration;

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
              style={{ aspectRatio: `${canvasSize.width} / ${canvasSize.height}` }}
              maxH="100%"
              maxW="100%"
              h="100%"
            >
              <video
                ref={videoRef}
                src={source?.rangeVideoUrl ?? result.previewUrl}
                playsInline
                preload="auto"
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setLoadError("This video could not be loaded for editing.")}
                style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
              />
              <canvas
                ref={canvasRef}
                width={canvasSize.width}
                height={canvasSize.height}
                onPointerDown={handlePreviewPointerDown}
                style={{
                  width: "100%",
                  height: "100%",
                  display: "block",
                  cursor: tab === "framing" && source ? "grab" : "pointer",
                  touchAction: "none",
                }}
                aria-label="Preview"
              />
              {!edit && !loadError ? (
                <Flex position="absolute" inset={0} align="center" justify="center" pointerEvents="none">
                  <Spinner color="white" />
                </Flex>
              ) : null}
              {loadError ? (
                <Flex position="absolute" inset={0} align="center" justify="center" p={4} pointerEvents="none">
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
              { disabled: !hasCuts },
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

        <Flex
          direction="column"
          w={{ base: "full", lg: "360px" }}
          flexShrink={0}
          borderLeft={{ lg: "1px solid" }}
          borderTop={{ base: "1px solid", lg: "none" }}
          borderColor={theme.surface.hover}
          maxH={{ base: "45vh", lg: "none" }}
          minH={0}
        >
          <HStack gap={1} p={3} pb={0} flexShrink={0}>
            {tabs.map((item) => (
              <Box
                key={item.id}
                as="button"
                flex={1}
                py={2}
                fontSize="sm"
                fontWeight="semibold"
                borderBottom="2px solid"
                borderColor={tab === item.id ? clipperTheme.accentGlow : "transparent"}
                color={tab === item.id ? theme.text.primary : theme.text.muted}
                cursor="pointer"
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </Box>
            ))}
          </HStack>
          <Box p={4} overflowY="auto" css={scrollbarCss} flex={1} minH={0}>
            {!edit ? null : tab === "edit" ? (
              <ClipperEditorSidePanel
                edit={edit}
                outputDuration={outputDuration}
                outputTime={outputTime}
                onChange={(updater) => applyEdit(updater, { coalesce: true })}
                onAddText={addText}
              />
            ) : !source ? (
              <VStack align="stretch" gap={2} p={4} borderRadius="lg" border="1px solid" borderColor={theme.surface.hover}>
                <Text fontSize="sm" fontWeight="semibold">
                  {tab === "captions" ? "Caption editing" : "Framing"} needs the original clip
                </Text>
                <Text fontSize="xs" color={theme.text.muted}>
                  Captions and framing are burned into this file, so changing them re-renders the clip from your
                  project's source video. That isn't available for this export: the project's video isn't loaded, or
                  this clip's start and end have changed since it was exported. Re-render the clip from Preview to
                  edit it here.
                </Text>
              </VStack>
            ) : tab === "captions" ? (
              <ClipperEditorCaptionsPanel
                groups={captionGroups}
                edited={edit.captionGroups !== null}
                visible={captionsVisible}
                currentTime={currentTime}
                onToggleVisible={() => applyEdit((current) => ({ ...current, captionsVisible: !captionsVisible }))}
                onChangeText={changeCaption}
                onSeek={(time) => {
                  videoRef.current?.pause();
                  seek(time);
                }}
                onReset={() => applyEdit((current) => ({ ...current, captionGroups: null }))}
              />
            ) : (
              <ClipperEditorFramingPanel
                segment={framingSegment}
                segmentNumber={segmentIndex + 1}
                partCount={edit.segments.length}
                onChange={(framing) => framingSegment && setSegmentFraming(framingSegment.id, framing)}
                onLock={lockFraming}
                onApplyToAll={applyFramingToAll}
              />
            )}
          </Box>
        </Flex>
      </Flex>
    </Flex>,
    document.body,
  );
};
