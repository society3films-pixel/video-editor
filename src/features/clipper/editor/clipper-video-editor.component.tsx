import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Button, Flex, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Film, Pause, Play, RotateCcw, Scissors, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { appToast } from "../../../shared/utils/toast.service";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipperFormatDef } from "../shared/formats.util";
import { splitFaceTracksFor, trackedPositionAt } from "../engine/render/split-tracking.util";
import {
  evaluateFramingTrack,
  isForcedSplit,
  splitPanelIndexAt,
  shotRangeAt,
  type ClipFramingTrack,
  type ClipperFramingValue,
} from "../engine/render/framing-override.util";
import {
  addFramingKeyframe,
  addShotBoundary,
  applyFramingToAllShots,
  clipEditChangesCaptions,
  createDefaultFramingValue,
  framingShotBoundaries,
  framingTracksEqual,
  KEYFRAME_SNAP_SEC,
  keyframesInShot,
  removeFramingKeyframe,
  removeShotBoundary,
  resetShotFraming,
  setFramingAt,
  splitClipEditAtShots,
  createInitialClipEdit,
  createTextOverlay,
  findNextSegment,
  findSegmentAt,
  formatEditorTime,
  getFadeFactor,
  getOutputDuration,
  removeClipEditSegment,
  resetClipEditCuts,
  setCaptionGroupText,
  sourceToOutputTime,
  splitClipEditAt,
  trimClipEditSegment,
  type ClipEdit,
} from "./clip-edit.util";
import type { PersistedClipEdit } from "./clip-edit-persist.util";
import { applyEditToFrameContext, type ClipEditorSource } from "./clip-editor-source.util";
import {
  createEditorTimeMap,
  dragFraming,
  drawEditorPreviewFrame,
  dragSplitPanel,
  lockedFramingFromAi,
  previewCanvasSize,
  splitPanelsFromAi,
} from "./clip-editor-preview.util";
import { ClipperEditorTimeline } from "./clipper-editor-timeline.component";
import { ClipperEditorSidePanel } from "./clipper-editor-side-panel.component";
import { ClipperEditorCaptionsPanel, ClipperEditorFramingPanel, type SpeakerDetectStatus } from "./clipper-editor-source-panels.component";
import { resolveSourceFile, saveEditedClipperExport } from "./save-edited-export.util";
import {
  applyAutoEdit,
  DEFAULT_AUTO_EDIT_OPTIONS,
  describeAutoEdit,
  measureLevelGain,
  type AutoEditOptions,
} from "./auto-edit.util";
import { ClipperAutoEditPanel } from "./clipper-auto-edit-panel.component";
import { ClipperAiEditorPanel, type AiEditorTurn } from "./ai-editor/clipper-ai-editor-panel.component";
import { requestEdit, type AiProvider } from "./ai-editor/ai-editor-providers.util";
import { buildAiEditMessages } from "./ai-editor/ai-editor-prompt.util";
import { applyAiEditPlan, parseAiEditReply } from "./ai-editor/ai-editor-ops.util";
import { detectSpeakers } from "./speaker-detect.util";
import { loadEditorAsset } from "./editor-assets.util";
import { clearKeywords, highlightKeywords, toggleWordEmphasis } from "./caption-keywords.util";

interface ClipperVideoEditorProps {
  /**
   * Export mode: the unedited export whose file cuts and text are applied to. Omit for clip
   * mode (Preview's "Fix framing"), which edits only the clip's framing.
   */
  result?: ClipperFormatResult;
  /** The export the user opened (may be an edited copy of `result`); used for title and metadata. */
  openedResult?: ClipperFormatResult;
  /** A previously saved edit to continue from. */
  savedEdit?: PersistedClipEdit | null;
  /** Clip mode title, e.g. "Clip 3". */
  clipTitle?: string;
  /** Clip mode: formats the framing can be previewed in. */
  formatOptions?: ClipperFormatDef[];
  onFormatChange?: (formatId: string) => void;
  /** Saves the clip's framing to the project (applies to Preview and every format). */
  onSaveFraming?: (track: ClipFramingTrack) => Promise<void>;
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

type PanelTab = "edit" | "ai" | "captions" | "framing";

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
  openedResult,
  savedEdit = null,
  clipTitle,
  formatOptions = [],
  onFormatChange,
  onSaveFraming,
  projectId,
  source = null,
  onClose,
  onSaved,
}) => {
  const clipMode = !result;
  const { theme, scrollbarCss } = useClipperUi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const outputWidth = source?.outputSize.width ?? result?.width ?? 1080;
  const outputHeight = source?.outputSize.height ?? result?.height ?? 1920;
  const canvasSize = useMemo(
    () => previewCanvasSize({ width: outputWidth, height: outputHeight }),
    [outputWidth, outputHeight],
  );

  const [duration, setDuration] = useState(source?.duration ?? 0);
  const [edit, setEdit] = useState<ClipEdit | null>(() => {
    if (!source) return null;
    const base = savedEdit ?? createInitialClipEdit(source.duration);
    return { ...base, framing: source.framingTrack };
  });
  /** What the editor opened with, to tell whether anything changed. */
  const baselineRef = useRef<{ edit: string; framing: ClipFramingTrack | null } | null>(null);
  const [history, setHistory] = useState<ClipEdit[]>([]);
  const lastHistoryPushRef = useRef(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>(clipMode ? "framing" : "edit");
  const [autoEditOpen, setAutoEditOpen] = useState(false);
  const [autoEditRunning, setAutoEditRunning] = useState(false);
  const [autoEditOptions, setAutoEditOptions] = useState<AutoEditOptions>(DEFAULT_AUTO_EDIT_OPTIONS);
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

  if (edit && !baselineRef.current) {
    baselineRef.current = { edit: JSON.stringify({ ...edit, framing: null }), framing: edit.framing };
  }
  const outputDuration = edit ? getOutputDuration(edit.segments) : 0;
  const outputTime = edit ? sourceToOutputTime(edit.segments, currentTime) : 0;
  const framingChanged = edit ? !framingTracksEqual(edit.framing, baselineRef.current?.framing ?? null) : false;
  const editChanged = edit ? JSON.stringify({ ...edit, framing: null }) !== baselineRef.current?.edit : false;
  const dirty = framingChanged || (!clipMode && editChanged);
  const isEditedVersion = Boolean(savedEdit);
  const titleResult = openedResult ?? result;

  const shotBoundaries = useMemo(
    () => (edit?.framing && source ? framingShotBoundaries(edit.framing, source.aiShotBoundaries) : []),
    [edit?.framing, source],
  );
  const shot = shotRangeAt(shotBoundaries, currentTime, duration);
  const shotKeyframes = edit?.framing ? keyframesInShot(edit.framing, shotBoundaries, currentTime) : [];
  const framingValue = edit?.framing ? evaluateFramingTrack(edit.framing, shotBoundaries, currentTime) : undefined;
  const keyframeAtPlayhead = shotKeyframes.find((k) => Math.abs(k.t - currentTime) <= KEYFRAME_SNAP_SEC);
  const userShotStart = Boolean(edit?.framing?.extraShotBoundaries.some((b) => Math.abs(b - shot.start) <= 0.05));
  const faceCache = source?.frameContext.faceCache ?? null;
  const splitTrackedHere = useMemo(() => {
    if (!faceCache || !source) return false;
    const tracks = splitFaceTracksFor(faceCache);
    const videoTime = createEditorTimeMap(source, duration).toVideo(currentTime);
    return Boolean(trackedPositionAt(tracks.left, videoTime) && trackedPositionAt(tracks.right, videoTime));
  }, [currentTime, duration, faceCache, source]);

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
  // Background music preview: an <audio> element kept in step with the edit's output time.
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAssetId = edit?.music?.assetId ?? null;
  useEffect(() => {
    if (!musicAssetId) return;
    let url: string | null = null;
    let cancelled = false;
    void loadEditorAsset(musicAssetId).then((file) => {
      if (!file || cancelled) return;
      url = URL.createObjectURL(file);
      const audio = new Audio(url);
      audio.loop = true;
      musicAudioRef.current = audio;
    });
    return () => {
      cancelled = true;
      musicAudioRef.current?.pause();
      musicAudioRef.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [musicAssetId]);

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
        const music = musicAudioRef.current;
        if (music) {
          if (video.paused || !current.music) {
            if (!music.paused) music.pause();
          } else {
            const outputT = sourceToOutputTime(current.segments, local);
            const songLength = Number.isFinite(music.duration) && music.duration > 0 ? music.duration : Infinity;
            const desired = (current.music.startSec + outputT) % songLength;
            if (Math.abs(music.currentTime - desired) > 0.3) music.currentTime = desired;
            music.volume = Math.min(1, Math.max(0, current.music.volume * getFadeFactor(current, outputT, total)));
            if (music.paused) void music.play().catch(() => {});
          }
        }

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
      : Math.max(0, (result?.clipEndSec ?? 0) - (result?.clipStartSec ?? 0));
    setDuration(d);
    setEdit((current) => current ?? { ...(savedEdit ?? createInitialClipEdit(d)), framing: null });
  }, [result, savedEdit, source]);

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

  const updateFraming = useCallback(
    (updater: (track: ClipFramingTrack) => ClipFramingTrack, options: { coalesce?: boolean; record?: boolean } = {}) => {
      applyEdit((current) => (current.framing ? { ...current, framing: updater(current.framing) } : current), options);
    },
    [applyEdit],
  );

  const localNow = useCallback(() => {
    const video = videoRef.current;
    return video ? timeMapRef.current.toLocal(video.currentTime) : currentTime;
  }, [currentTime]);

  const setFramingValue = useCallback(
    (value: ClipperFramingValue, coalesce = true) => {
      const t = localNow();
      updateFraming((track) => setFramingAt(track, shotBoundaries, t, value), { coalesce });
    },
    [localNow, shotBoundaries, updateFraming],
  );

  const [speakerStatus, setSpeakerStatus] = useState<SpeakerDetectStatus>({ state: "idle" });
  const detectSpeakersNow = useCallback(async () => {
    if (!source || !faceCache) {
      setSpeakerStatus({ state: "error", message: "Face tracking isn't available for this clip yet." });
      return;
    }
    setSpeakerStatus({ state: "running", ratio: 0 });
    try {
      const spans = await detectSpeakers(source.rangeFile, faceCache.sortedSamples(), source.clip.segments, source.clip.words, duration, {
        onProgress: (ratio) => setSpeakerStatus({ state: "running", ratio }),
      });
      updateFraming((track) => ({ ...track, speakers: spans }), { coalesce: false });
      setSpeakerStatus(
        spans.length
          ? { state: "idle" }
          : { state: "error", message: "Couldn't tell who's talking. Both faces need to be visible while people speak." },
      );
    } catch (error) {
      setSpeakerStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [duration, faceCache, source, updateFraming]);

  const forceSplit = useCallback(() => {
    const video = videoRef.current;
    if (!source || !video || !video.videoWidth) return;
    const panels = splitPanelsFromAi(
      source,
      source.frameContext,
      { width: video.videoWidth, height: video.videoHeight },
      video.currentTime,
    );
    // Start AI-tracked: each panel follows one person; the panels above are the fallback.
    setFramingValue(
      { ...(framingValue ?? createDefaultFramingValue()), singleShot: false, split: panels, splitFollow: true, splitSwap: false },
      false,
    );
  }, [framingValue, setFramingValue, source]);

  const lockFraming = useCallback(() => {
    const video = videoRef.current;
    if (!source || !video || !video.videoWidth) return;
    const next = lockedFramingFromAi(
      source,
      source.frameContext,
      { width: video.videoWidth, height: video.videoHeight },
      video.currentTime,
      framingValue ?? createDefaultFramingValue(),
    );
    setFramingValue(next, false);
  }, [framingValue, setFramingValue, source]);

  const addKeyframe = useCallback(() => {
    const t = localNow();
    updateFraming((track) => addFramingKeyframe(track, t, framingValue ?? createDefaultFramingValue()));
  }, [framingValue, localNow, updateFraming]);

  const applyFramingToAll = useCallback(() => {
    if (!framingValue) return;
    updateFraming((track) => applyFramingToAllShots(track, shotBoundaries, duration, framingValue));
  }, [duration, framingValue, shotBoundaries, updateFraming]);

  const splitAtShots = useCallback(() => {
    if (shotBoundaries.length === 0) return;
    applyEdit((current) => splitClipEditAtShots(current, shotBoundaries));
  }, [applyEdit, shotBoundaries]);

  /** Click toggles playback; dragging (on the Framing tab) repositions the camera. */
  const handlePreviewPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const canvas = event.currentTarget;
      const video = videoRef.current;
      const canDrag = Boolean(source && tab === "framing" && edit?.framing && video?.videoWidth);
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(1, rect.width);
      const scaleY = canvas.height / Math.max(1, rect.height);
      const startFraming = framingValue ?? createDefaultFramingValue();
      const splitPanelIndex = isForcedSplit(startFraming)
        ? splitPanelIndexAt(
            { width: canvas.width, height: canvas.height },
            (startX - rect.left) * scaleX,
            (startY - rect.top) * scaleY,
          )
        : -1;
      const dragTime = localNow();
      let dragging = false;
      canvas.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!canDrag || !video) return;
        if (!dragging) {
          const current = editRef.current;
          if (current) pushHistory(current, false);
          dragging = true;
        }
        const previewSize = { width: canvas.width, height: canvas.height };
        const videoSize = { width: video.videoWidth, height: video.videoHeight };
        const next =
          splitPanelIndex >= 0
            ? {
                ...startFraming,
                split: dragSplitPanel(
                  startFraming.split!,
                  splitPanelIndex,
                  dx * scaleX,
                  dy * scaleY,
                  previewSize,
                  videoSize,
                  Boolean(startFraming.splitFollow),
                ),
              }
            : dragFraming(startFraming, dx * scaleX, dy * scaleY, previewSize, videoSize);
        updateFraming((track) => setFramingAt(track, shotBoundaries, dragTime, next), { record: false });
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
    [edit?.framing, framingValue, localNow, pushHistory, shotBoundaries, source, tab, togglePlay, updateFraming],
  );

  // ---- Save / close ---------------------------------------------------------------------------

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty && !window.confirm("Discard your edits?")) return;
    onClose();
  }, [dirty, onClose, saving]);

  const autoEditWords = source?.clip.words ?? [];
  const autoEditFaceCache = source?.frameContext.faceCache ?? null;

  const runAutoEdit = useCallback(async () => {
    const current = editRef.current;
    if (!current || autoEditRunning) return;
    videoRef.current?.pause();
    setAutoEditRunning(true);
    try {
      const options: AutoEditOptions = clipMode
        ? { cutPauses: false, fixFraming: autoEditOptions.fixFraming, punchIns: false, hookTitle: false, levelVolume: false, highlightKeywords: false }
        : autoEditOptions;
      let levelGain: number | null = null;
      if (options.levelVolume && result) {
        const measured = await measureLevelGain(await resolveSourceFile(result, projectId)).catch(() => null);
        levelGain = measured?.gain ?? null;
      }
      const { edit: next, summary } = applyAutoEdit(
        current,
        {
          duration,
          words: autoEditWords,
          socialTitle: (openedResult ?? result)?.socialTitle,
          framing:
            source && autoEditFaceCache
              ? {
                  aiShotBoundaries: source.aiShotBoundaries,
                  faceSamples: autoEditFaceCache.sortedSamples(),
                  clipSegments: source.clip.segments,
                  outputAspect: outputWidth / Math.max(1, outputHeight),
                }
              : undefined,
          levelGain,
          // Captions can only be changed when editing an export (clip mode edits framing only).
          captionGroups: result ? (current.captionGroups ?? source?.frameContext.captionGroups) : undefined,
        },
        options,
      );
      applyEdit(() => next);
      setSelectedSegmentId(null);
      setAutoEditOpen(false);
      appToast.success("Auto edit applied", describeAutoEdit(summary));
    } catch (error) {
      appToast.error("Auto edit failed", error instanceof Error ? error.message : String(error));
    } finally {
      setAutoEditRunning(false);
    }
  }, [
    applyEdit,
    autoEditFaceCache,
    autoEditOptions,
    autoEditRunning,
    autoEditWords,
    clipMode,
    duration,
    openedResult,
    outputHeight,
    outputWidth,
    projectId,
    result,
    source,
  ]);

  const runAiEdit = useCallback(
    async (instruction: string, provider: AiProvider, model: string): Promise<AiEditorTurn> => {
      const current = editRef.current;
      if (!current) return { instruction, summary: "", applied: [], skipped: [], error: "The editor isn't ready yet." };
      videoRef.current?.pause();
      const captionGroups = current.captionGroups ?? source?.frameContext.captionGroups ?? [];
      const shotBoundaries = current.framing && source ? framingShotBoundaries(current.framing, source.aiShotBoundaries) : [];
      try {
        const messages = buildAiEditMessages(instruction, current, {
          duration,
          words: autoEditWords,
          captionGroups,
          shotBoundaries,
          canChangeSource: Boolean(source),
          title: (openedResult ?? result)?.socialTitle,
        });
        const plan = parseAiEditReply(await requestEdit(provider, model, messages));
        // Apply to the latest state, in case the user edited while the AI was thinking.
        const latest = editRef.current ?? current;
        const outcome = applyAiEditPlan(latest, plan, {
          duration,
          words: autoEditWords,
          captionGroups,
          aiShotBoundaries: source?.aiShotBoundaries ?? [],
          canChangeSource: Boolean(source),
        });
        if (outcome.applied.length > 0) {
          applyEdit(() => outcome.edit);
          setSelectedSegmentId(null);
        }
        return { instruction, summary: plan.summary, applied: outcome.applied, skipped: outcome.skipped };
      } catch (error) {
        return { instruction, summary: "", applied: [], skipped: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    [applyEdit, autoEditWords, duration, openedResult, result, source],
  );

  const save = useCallback(async () => {
    const current = editRef.current;
    if (!current || saving) return;
    videoRef.current?.pause();
    const controller = new AbortController();
    abortRef.current = controller;
    setSaving(true);
    setSaveProgress(0);
    try {
      if (current.framing && framingChanged && onSaveFraming) {
        await onSaveFraming(current.framing);
      }
      if (clipMode) {
        appToast.success("Framing saved", "Preview, the render queue and every format now use it.");
        onSaved();
        onClose();
        return;
      }
      // Re-render from the source when captions or framing differ from what the file holds.
      const staleExport = Boolean(
        source && result!.renderSignature && result!.renderSignature !== source.renderSignature,
      );
      const needsSourceRender = Boolean(source) && (clipEditChangesCaptions(current) || framingChanged || staleExport);
      const outcome = await saveEditedClipperExport(projectId, result!, current, duration, {
        signal: controller.signal,
        onProgress: setSaveProgress,
        source,
        needsSourceRender,
        metadataFrom: openedResult,
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
        appToast.error(clipMode ? "Could not save framing" : "Could not save the edited clip", message);
      }
    } finally {
      abortRef.current = null;
      setSaving(false);
    }
  }, [clipMode, duration, framingChanged, onClose, onSaveFraming, onSaved, openedResult, projectId, result, saving, source]);

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
      } else if (event.key.toLowerCase() === "s" && !event.ctrlKey && !event.metaKey && !clipMode) {
        event.preventDefault();
        splitAtPlayhead();
      } else if ((event.key === "Delete" || event.key === "Backspace") && !clipMode) {
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
  }, [clipMode, deleteSelected, requestClose, saving, seek, splitAtPlayhead, togglePlay, undo]);

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

  const tabs: { id: PanelTab; label: string }[] = clipMode
    ? [{ id: "framing", label: "Framing" }]
    : [
        { id: "edit", label: "Edit" },
        { id: "ai", label: "AI" },
        { id: "captions", label: "Captions" },
        { id: "framing", label: "Framing" },
      ];
  const title = clipMode
    ? `Fix framing · ${clipTitle ?? "Clip"}`
    : `Edit clip ${(titleResult?.clipIndex ?? 0) + 1} · ${titleResult?.label ?? ""}${isEditedVersion ? " (edited)" : ""}`;
  const subtitle = clipMode
    ? "Framing is saved to this clip and used by Preview, the render queue and every format."
    : isEditedVersion
      ? "Continuing your saved edit. Saving makes a new export; earlier versions stay."
      : "Saves a new export. The original stays as it is. Framing changes are saved to the clip.";
  const hasCuts = (edit?.segments.length ?? 0) !== 1 || edit?.segments[0]?.start !== 0 || edit?.segments[0]?.end !== duration;

  return createPortal(
    <Flex
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
            {title}
          </Text>
          <Text fontSize="xs" color={theme.text.muted}>
            {subtitle}
          </Text>
        </VStack>
        <HStack gap={2}>
          <Box position="relative">
            <OutlinedActionButton
              startIcon={<Sparkles size={16} />}
              onClick={() => setAutoEditOpen((open) => !open)}
              disabled={saving || !edit}
              title={clipMode ? "Fix framing automatically" : "Let the app make a first edit for you"}
            >
              {clipMode ? "Auto-fix" : "Auto edit"}
            </OutlinedActionButton>
            {autoEditOpen ? (
              <ClipperAutoEditPanel
                options={autoEditOptions}
                onChange={setAutoEditOptions}
                onApply={() => void runAutoEdit()}
                onCancel={() => setAutoEditOpen(false)}
                running={autoEditRunning}
                framingOnly={clipMode}
                hasTranscript={autoEditWords.length > 0}
                hasFaceTracking={Boolean(source && autoEditFaceCache && edit?.framing)}
                hasExportAudio={Boolean(result)}
              />
            ) : null}
          </Box>
          {clipMode && formatOptions.length > 1 && source ? (
            <select
              value={source.formatDef.id}
              onChange={(event) => onFormatChange?.(event.target.value)}
              disabled={saving}
              aria-label="Preview format"
              title="Framing is shared by every format; preview it in each one"
              style={{
                height: 36,
                background: "rgba(0,0,0,0.35)",
                color: "inherit",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                padding: "0 8px",
                fontSize: 13,
              }}
            >
              {formatOptions.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.label} preview
                </option>
              ))}
            </select>
          ) : null}
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
            ) : clipMode ? (
              "Save framing"
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
                src={source?.rangeVideoUrl ?? result?.previewUrl}
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
            {clipMode ? (
              toolButton("Undo", <Undo2 size={14} />, undo, { shortcut: "Ctrl+Z", disabled: history.length === 0 })
            ) : (
              <>
            {toolButton("Split at shot changes", <Film size={14} />, splitAtShots, {
              disabled: shotBoundaries.length === 0,
            })}
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
              </>
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
                shotBoundaries={shotBoundaries}
                keyframes={edit.framing?.keyframes}
                editableParts={!clipMode}
              />
              <Text fontSize="xs" color={theme.text.muted} mt={2}>
                {clipMode
                  ? "Dashed lines are shot changes; diamonds are framing keyframes. Move the playhead to the shot that looks wrong and fix it on the right."
                  : "Drag the edges of a part to trim it. Move the playhead and press Split (S) to cut, then select a part and Delete it. Striped areas are removed from the saved clip. Dashed lines are shot changes."}
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
                activeSegmentId={selectedSegmentId ?? findSegmentAt(edit.segments, currentTime)?.id ?? null}
              />
            ) : tab === "ai" ? (
              <ClipperAiEditorPanel onRun={runAiEdit} hasTranscript={autoEditWords.length > 0} disabled={saving} />
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
                onToggleKeyword={(groupIndex, wordIndex) =>
                  applyEdit((current) => ({
                    ...current,
                    captionGroups: toggleWordEmphasis(current.captionGroups ?? source?.frameContext.captionGroups ?? [], groupIndex, wordIndex),
                  }))
                }
                onAutoKeywords={() =>
                  applyEdit((current) => ({
                    ...current,
                    captionGroups: highlightKeywords(current.captionGroups ?? source?.frameContext.captionGroups ?? []).groups,
                  }))
                }
                onClearKeywords={() =>
                  applyEdit((current) => ({
                    ...current,
                    captionGroups: clearKeywords(current.captionGroups ?? source?.frameContext.captionGroups ?? []),
                  }))
                }
              />
            ) : (
              <ClipperEditorFramingPanel
                shot={{ ...shot, count: shotBoundaries.length + 1 }}
                value={framingValue}
                keyframes={shotKeyframes}
                keyframeAtPlayhead={keyframeAtPlayhead}
                userShotStart={userShotStart}
                currentTime={currentTime}
                onChange={(value) => setFramingValue(value)}
                onLock={lockFraming}
                onForceSplit={forceSplit}
                sideBySide={outputWidth > outputHeight}
                splitTrackedHere={splitTrackedHere}
                speakerTurns={edit.framing?.speakers?.length ?? 0}
                speakerStatus={speakerStatus}
                onDetectSpeakers={() => void detectSpeakersNow()}
                onAddKeyframe={addKeyframe}
                onRemoveKeyframe={(id) => updateFraming((track) => removeFramingKeyframe(track, id))}
                onSeek={(time) => {
                  videoRef.current?.pause();
                  seek(time);
                }}
                onResetShot={() => updateFraming((track) => resetShotFraming(track, shotBoundaries, localNow()))}
                onApplyToAll={applyFramingToAll}
                onAddShotBoundary={() => {
                  const t = localNow();
                  updateFraming((track) => addShotBoundary(track, t));
                }}
                onRemoveShotBoundary={() => updateFraming((track) => removeShotBoundary(track, shot.start))}
              />
            )}
          </Box>
        </Flex>
      </Flex>
    </Flex>,
    document.body,
  );
};
