export interface AiClipSegmentRange {
  wordStartIdx: number;
  wordEndIdx: number;
  /**
   * Exact start / end (range time) chosen by hand, e.g. to keep a pause or music before or after
   * the words. When set, these are used as they are instead of padding the words' times.
   */
  exactStartSec?: number;
  exactEndSec?: number;
}

export interface AiClipWordRange {
  segments: AiClipSegmentRange[];
  label?: string;
  index?: number;
}

export interface AiClipPickInput {
  index: number;
  segments: AiClipSegmentRange[];
  startSec: number;
  endSec: number;
  durationSec: number;
  label?: string;
}

export interface WordMarginOptions {
  preRollSec?: number;
  postRollSec?: number;
  minGapSec?: number;
}
