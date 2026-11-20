import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playPreviewVideo } from "../shared/play-preview-video.util";
import type { WordCue } from "../lib/media/transcription-export.util";
import type { AiClipSegmentRange } from "../engine/types/transcript.types";
import {
  nextWordRangeSelection,
  selectionWithinTimeRange,
  timeRangeFromSelection,
  wordRangeTimes,
  type WordRangeSelection,
} from "../components/clipper-manual-clip-range.util";

const WINDOW_MIN_SPAN_SEC = 1;

export type ManualClipPlaybackMode = "select" | "watch";

export function useClipperManualClipRange({
  isOpen,
  words,
  durationSec,
  initialRange,
}: {
  isOpen: boolean;
  words: WordCue[];
  durationSec: number;
  initialRange?: AiClipSegmentRange | null;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekRafRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<ManualClipPlaybackMode>("select");
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [selection, setSelection] = useState<WordRangeSelection>({
    startIdx: null,
    endIdx: null,
  });
  /** The range was set with the time slider: save its exact times (silence before / after kept). */
  const [exactTimes, setExactTimes] = useState(false);
  const [clipTimeRange, setClipTimeRange] = useState<[number, number]>([
    0,
    Math.max(durationSec, 0),
  ]);

  const bindVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideo(el);
  }, []);

  const resetFromInitial = useCallback(() => {
    const duration = Math.max(durationSec, 0);
    setPlaybackMode("select");
    setCurrentTimeSec(0);
    if (initialRange) {
      const times = wordRangeTimes(words, initialRange.wordStartIdx, initialRange.wordEndIdx);
      setSelection({
        startIdx: initialRange.wordStartIdx,
        endIdx: initialRange.wordEndIdx,
      });
      const exact = initialRange.exactStartSec != null && initialRange.exactEndSec != null;
      setExactTimes(exact);
      setClipTimeRange(
        exact
          ? [initialRange.exactStartSec!, initialRange.exactEndSec!]
          : times
            ? [times.startSec, times.endSec]
            : [0, duration],
      );
      return;
    }
    setExactTimes(false);
    setSelection({ startIdx: null, endIdx: null });
    setClipTimeRange([0, duration]);
  }, [durationSec, initialRange, words]);

  useEffect(() => {
    if (!isOpen) {
      videoRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    resetFromInitial();
  }, [isOpen, resetFromInitial]);

  useEffect(
    () => () => {
      if (seekRafRef.current != null) cancelAnimationFrame(seekRafRef.current);
    },
    [],
  );

  const selectedTimes = useMemo(() => {
    if (exactTimes) return { startSec: clipTimeRange[0], endSec: clipTimeRange[1] };
    return wordRangeTimes(words, selection.startIdx, selection.endIdx);
  }, [clipTimeRange, exactTimes, selection.endIdx, selection.startIdx, words]);

  /** Updates the UI time immediately; the actual video seek is coalesced to one per frame. */
  const seekTo = useCallback((timeSec: number) => {
    const clamped = Math.max(0, Math.min(timeSec, Math.max(durationSec, 0)));
    setCurrentTimeSec(clamped);
    pendingSeekRef.current = clamped;
    if (seekRafRef.current != null) return;
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = null;
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (target != null && videoRef.current) videoRef.current.currentTime = target;
    });
  }, [durationSec]);

  const handleClipTimeChange = useCallback(
    (value: number[]) => {
      let [start, end] = value;
      if (end - start < WINDOW_MIN_SPAN_SEC) {
        end = Math.min(durationSec, start + WINDOW_MIN_SPAN_SEC);
        start = Math.max(0, end - WINDOW_MIN_SPAN_SEC);
      }
      setClipTimeRange([start, end]);
      // The words inside the chosen time (the clip keeps any silence or music around them).
      setSelection(selectionWithinTimeRange(words, start, end));
      setExactTimes(true);
      seekTo(start);
    },
    [durationSec, seekTo, words],
  );

  const handlePlayheadChange = useCallback(
    (value: number[]) => {
      const [timeSec] = value;
      if (timeSec == null) return;
      seekTo(timeSec);
    },
    [seekTo],
  );

  const handleWordClick = useCallback(
    (index: number) => {
      const word = words[index];
      if (!word) return;
      if (playbackMode === "watch") {
        seekTo(word.start);
        return;
      }
      const next = nextWordRangeSelection(selection, index);
      setSelection(next);
      setExactTimes(false);
      if (next.endIdx == null) {
        setClipTimeRange([word.start, Math.max(word.end, word.start)]);
      } else {
        const times = timeRangeFromSelection(words, next);
        if (times) setClipTimeRange(times);
      }
      seekTo(word.start);
    },
    [playbackMode, seekTo, selection, words],
  );

  const togglePlay = useCallback(() => {
    if (!video) return;
    if (video.paused) {
      if (playbackMode === "select" && selectedTimes) {
        if (
          video.currentTime >= selectedTimes.endSec - 0.05 ||
          video.currentTime < selectedTimes.startSec
        ) {
          video.currentTime = selectedTimes.startSec;
        }
      }
      void playPreviewVideo(video);
      return;
    }
    video.pause();
  }, [playbackMode, selectedTimes, video]);

  useEffect(() => {
    if (!video || !isOpen) return;

    const syncPlaying = () => setIsPlaying(!video.paused && !video.ended);
    const syncCurrentTime = () => setCurrentTimeSec(video.currentTime);
    const loopSelection = () => {
      if (playbackMode !== "select" || !selectedTimes || video.paused) return;
      if (video.currentTime >= selectedTimes.endSec - 0.04) {
        video.currentTime = selectedTimes.startSec;
      }
    };

    video.addEventListener("play", syncPlaying);
    video.addEventListener("pause", syncPlaying);
    video.addEventListener("ended", syncPlaying);
    video.addEventListener("timeupdate", syncCurrentTime);
    video.addEventListener("timeupdate", loopSelection);
    video.addEventListener("seeked", syncCurrentTime);
    syncPlaying();
    syncCurrentTime();
    return () => {
      video.removeEventListener("play", syncPlaying);
      video.removeEventListener("pause", syncPlaying);
      video.removeEventListener("ended", syncPlaying);
      video.removeEventListener("timeupdate", syncCurrentTime);
      video.removeEventListener("timeupdate", loopSelection);
      video.removeEventListener("seeked", syncCurrentTime);
    };
  }, [isOpen, playbackMode, selectedTimes, video]);

  const canSave = selection.startIdx != null && selection.endIdx != null;

  /** What to save: the words, plus the exact times when they were set with the slider. */
  const savedRange = (): AiClipSegmentRange | null => {
    if (selection.startIdx == null || selection.endIdx == null) return null;
    const range = { wordStartIdx: selection.startIdx, wordEndIdx: selection.endIdx };
    return exactTimes ? { ...range, exactStartSec: clipTimeRange[0], exactEndSec: clipTimeRange[1] } : range;
  };

  return {
    video,
    bindVideo,
    exactTimes,
    savedRange,
    isPlaying,
    playbackMode,
    setPlaybackMode,
    currentTimeSec,
    selection,
    clipTimeRange,
    selectedTimes,
    canSave,
    handleClipTimeChange,
    handlePlayheadChange,
    handleWordClick,
    togglePlay,
  };
}
