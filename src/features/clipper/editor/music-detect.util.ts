/**
 * Finds where music is playing (songs, instrumental passages) as opposed to talking, so editing
 * leaves performances alone. Speech has many short dips in level between syllables and words;
 * music keeps a steadier level. Per one-second window: the share of 20 ms frames well below the
 * window's average level (the "low-energy ratio"), plus how much of the window is transcribed
 * as talking. Windows are smoothed into sections of at least 4 seconds.
 */
import { AudioBufferSink } from "mediabunny";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../shared/utils/platform.util";
import { getNativeFilePath } from "../platform/native-source.util";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import type { WordCue } from "../lib/media/transcription-export.util";

export interface MusicSection {
  /** Clip-local (file) time. */
  start: number;
  end: number;
  /** Gain that brings the music to the speech level (loudness balance), 1 = unchanged. */
  gain: number;
}

const FRAME_SEC = 0.02;
const WINDOW_FRAMES = 50; // 1 s
const MIN_SECTION_SEC = 4;
const SILENCE_RMS = 0.004;

/**
 * RMS per 20 ms frame of the file's audio (mono mix). Files on disk are decoded natively by the
 * desktop app (FFmpeg, much faster on long recordings); others in the webview.
 */
export async function frameLevels(file: File, signal?: AbortSignal): Promise<Float32Array> {
  const path = getNativeFilePath(file);
  if (path && isTauri()) {
    try {
      const levels = await invoke<number[]>("media_audio_levels", { path, frameMs: 20 });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return Float32Array.from(levels);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("[audio] Native level analysis failed; decoding in the app instead:", error);
    }
  }
  return frameLevelsInWebview(file, signal);
}

async function frameLevelsInWebview(file: File, signal?: AbortSignal): Promise<Float32Array> {
  const input = await createMediabunnyInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return new Float32Array(0);
    const levels: number[] = [];
    let sum = 0;
    let count = 0;
    let frameSize = 0;
    for await (const { buffer } of new AudioBufferSink(track).buffers()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      frameSize ||= Math.max(1, Math.round(buffer.sampleRate * FRAME_SEC));
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      for (let i = 0; i < buffer.length; i++) {
        let v = 0;
        for (const data of channels) v += data[i]!;
        v /= channels.length;
        sum += v * v;
        if (++count >= frameSize) {
          levels.push(Math.sqrt(sum / count));
          sum = 0;
          count = 0;
        }
      }
    }
    return Float32Array.from(levels);
  } finally {
    input.dispose();
  }
}

/** Seconds of each window covered by transcribed words (speech or sung lyrics). */
function wordCoverage(words: readonly WordCue[], windows: number): Float32Array {
  const coverage = new Float32Array(windows);
  for (const word of words) {
    if (word.deleted) continue;
    for (let w = Math.floor(word.start); w <= Math.min(windows - 1, Math.floor(word.end)); w++) {
      coverage[w]! += Math.max(0, Math.min(word.end, w + 1) - Math.max(word.start, w));
    }
  }
  return coverage;
}

/** Music sections from frame levels (pure, for tests). */
export function musicSectionsFromLevels(levels: Float32Array, words: readonly WordCue[]): MusicSection[] {
  const windows = Math.floor(levels.length / WINDOW_FRAMES);
  if (windows < MIN_SECTION_SEC) return [];
  const coverage = wordCoverage(words, windows);
  const isMusic: boolean[] = [];
  for (let w = 0; w < windows; w++) {
    const frames = levels.subarray(w * WINDOW_FRAMES, (w + 1) * WINDOW_FRAMES);
    let mean = 0;
    for (const v of frames) mean += v;
    mean /= frames.length;
    if (mean < SILENCE_RMS) {
      isMusic.push(false);
      continue;
    }
    let low = 0;
    for (const v of frames) if (v < mean * 0.5) low++;
    const lowRatio = low / frames.length;
    // Steady level = music. Sung lyrics are transcribed too, so words alone don't mean speech;
    // they only tip borderline windows towards speech.
    const threshold = coverage[w]! > 0.6 ? 0.1 : 0.18;
    isMusic.push(lowRatio < threshold);
  }
  // Smooth: fill 1-2 s gaps inside music, drop music runs shorter than the minimum.
  for (let w = 1; w < windows - 1; w++) {
    if (!isMusic[w] && isMusic[w - 1] && (isMusic[w + 1] || isMusic[w + 2])) isMusic[w] = true;
  }
  const sections: MusicSection[] = [];
  let start = -1;
  for (let w = 0; w <= windows; w++) {
    if (w < windows && isMusic[w]) {
      if (start < 0) start = w;
    } else if (start >= 0) {
      if (w - start >= MIN_SECTION_SEC) sections.push({ start, end: w, gain: 1 });
      start = -1;
    }
  }
  return balanceLoudness(sections, levels);
}

/** Gain per music section so it plays at about the speech level (never more than ±9 dB). */
function balanceLoudness(sections: MusicSection[], levels: Float32Array): MusicSection[] {
  if (!sections.length) return sections;
  const inMusic = (frame: number) => sections.some((s) => frame * FRAME_SEC >= s.start && frame * FRAME_SEC < s.end);
  const loud = (values: number[]) => {
    const audible = values.filter((v) => v > SILENCE_RMS).sort((a, b) => b - a);
    const top = audible.slice(0, Math.max(1, Math.floor(audible.length * 0.6)));
    return top.length ? Math.sqrt(top.reduce((s, v) => s + v * v, 0) / top.length) : 0;
  };
  const speech: number[] = [];
  for (let f = 0; f < levels.length; f++) if (!inMusic(f)) speech.push(levels[f]!);
  const speechLevel = loud(speech);
  if (!speechLevel) return sections;
  return sections.map((section) => {
    const music: number[] = [];
    for (let f = Math.floor(section.start / FRAME_SEC); f < Math.min(levels.length, section.end / FRAME_SEC); f++) music.push(levels[f]!);
    const musicLevel = loud(music);
    const gain = musicLevel ? Math.min(2.8, Math.max(0.35, speechLevel / musicLevel)) : 1;
    return { ...section, gain: Number(gain.toFixed(3)) };
  });
}

export async function detectMusicSections(file: File, words: readonly WordCue[], signal?: AbortSignal): Promise<MusicSection[]> {
  return musicSectionsFromLevels(await frameLevels(file, signal), words);
}

export function inMusicSection(sections: readonly MusicSection[] | undefined, t: number): MusicSection | null {
  if (!sections) return null;
  for (const section of sections) if (t >= section.start && t < section.end) return section;
  return null;
}

/** 0..1 how far inside music `t` is, with a 0.3 s crossfade at the edges. */
export function musicAmount(sections: readonly MusicSection[] | undefined, t: number): { amount: number; gain: number } {
  if (!sections?.length) return { amount: 0, gain: 1 };
  const fade = 0.3;
  for (const section of sections) {
    if (t >= section.start - fade && t < section.end + fade) {
      const amount = Math.min(1, Math.max(0, Math.min((t - (section.start - fade)) / fade, (section.end + fade - t) / fade)));
      return { amount, gain: section.gain };
    }
  }
  return { amount: 0, gain: 1 };
}
