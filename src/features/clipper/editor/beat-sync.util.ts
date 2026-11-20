/**
 * Beat sync: finds the beat of the background music (energy onsets, tempo by autocorrelation,
 * phase by the strongest alignment) and pulses the picture slightly on each beat.
 */
import type { DecodedAudio } from "./audio-extras.util";

export interface BeatPulse {
  /** Beat times in main-edit output time. */
  beats: number[];
  /** Extra zoom at the peak of a pulse, e.g. 0.03 = 3%. */
  strength: number;
  /** Pulse every beat (1) or every other beat (2). */
  every: 1 | 2;
  bpm: number;
}

const HOP_SEC = 0.01;

/** Onset strength per 10 ms: rises in energy (half-wave rectified). */
export function onsetEnvelope(audio: DecodedAudio): Float32Array {
  const hop = Math.max(1, Math.round(audio.sampleRate * HOP_SEC));
  const frames = Math.floor(audio.channels[0]!.length / hop);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (const channel of audio.channels) {
      for (let i = f * hop; i < (f + 1) * hop; i++) sum += channel[i]! * channel[i]!;
    }
    energy[f] = Math.log1p(1000 * (sum / (hop * audio.channels.length)));
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  return onset;
}

/** Tempo (60-180 BPM) and beat times in seconds of the decoded audio. */
export function detectBeats(audio: DecodedAudio): { bpm: number; beats: number[] } | null {
  const onset = onsetEnvelope(audio);
  if (onset.length < 300) return null;
  const minLag = Math.round(60 / 180 / HOP_SEC);
  const maxLag = Math.round(60 / 60 / HOP_SEC);
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < onset.length; i++) score += onset[i]! * onset[i - lag]!;
    // Prefer tempos near 120 BPM a little (avoids half/double tempo picks).
    const bpm = 60 / (lag * HOP_SEC);
    score *= Math.exp(-((Math.log2(bpm / 120)) ** 2) * 0.5);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return null;
  let bestPhase = 0;
  let phaseScore = -1;
  for (let phase = 0; phase < bestLag; phase++) {
    let score = 0;
    for (let i = phase; i < onset.length; i += bestLag) score += onset[i]!;
    if (score > phaseScore) {
      phaseScore = score;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let i = bestPhase; i < onset.length; i += bestLag) beats.push(i * HOP_SEC);
  return { bpm: 60 / (bestLag * HOP_SEC), beats };
}

/** Beats moved onto the edit's timeline (the song starts at `startSec`, loops if shorter). */
export function beatsOnTimeline(beats: readonly number[], songStartSec: number, songDuration: number, outputDuration: number): number[] {
  if (!beats.length || songDuration <= 0) return [];
  const result: number[] = [];
  for (let loop = 0; loop * songDuration < outputDuration + songStartSec; loop++) {
    for (const beat of beats) {
      const t = beat + loop * songDuration - songStartSec;
      if (t >= 0 && t <= outputDuration) result.push(t);
    }
  }
  return result.sort((a, b) => a - b);
}

/** Zoom factor at output time `t`: a quick rise and a decay after each pulsed beat. */
export function beatPulseZoom(pulse: BeatPulse | null | undefined, t: number): number {
  if (!pulse?.beats.length) return 1;
  let lo = 0;
  let hi = pulse.beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pulse.beats[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const index = pulse.beats[lo]! <= t ? lo : -1;
  if (index < 0 || index % pulse.every !== 0) return 1;
  const since = t - pulse.beats[index]!;
  if (since > 0.35) return 1;
  const rise = Math.min(1, since / 0.04);
  return 1 + pulse.strength * rise * Math.exp(-since / 0.12);
}
