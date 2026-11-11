/**
 * Audio added on top of the clip's own sound when an edit is rendered: background music that
 * ducks under speech, and generated sound effects (a whoosh on cuts, a low hit on punch-ins).
 * Everything here works on planar float buffers in output time, chunk by chunk.
 */
import { AudioBufferSink } from "mediabunny";
import { createMediabunnyInput } from "../lib/media/mediabunny-file-source.util";
import { getFadeFactor, type ClipEdit, type ClipEditSegment } from "./clip-edit.util";

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export type SoundEffectKind = "whoosh" | "hit";
export interface SoundEffectEvent {
  /** Output time of the cut or punch-in. */
  t: number;
  kind: SoundEffectKind;
}

/** Music level while someone talks, relative to its normal level. */
export const DUCK_LEVEL = 0.3;
const DUCK_DOWN_SEC = 0.12;
const DUCK_UP_SEC = 0.6;
/** Voice envelope above this (about -34 dBFS) counts as talking. */
const SPEECH_THRESHOLD = 0.02;
const MUSIC_TAIL_FADE_SEC = 1.5;
/** No two effects closer than this, so a run of tight pause cuts doesn't become a drum roll. */
const MIN_EFFECT_GAP_SEC = 1.2;
const WHOOSH_SEC = 0.42;
/** The whoosh peaks this long after it starts, so the peak lands on the cut. */
const WHOOSH_LEAD_SEC = 0.24;
const HIT_SEC = 0.35;

/** Cuts (jumps in the source) and punch-in starts, in output time. */
export function soundEffectEvents(segments: readonly ClipEditSegment[], options: { cuts: boolean; punchIns: boolean }): SoundEffectEvent[] {
  const events: SoundEffectEvent[] = [];
  let offset = 0;
  let last = -Infinity;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const previous = segments[i - 1];
    if (previous) {
      const jumped = segment.start - previous.end > 0.05;
      const punched = (segment.zoom ?? 1) > 1.001 && (segment.zoom ?? 1) !== (previous.zoom ?? 1);
      const kind: SoundEffectKind | null = punched && options.punchIns ? "hit" : jumped && options.cuts ? "whoosh" : null;
      if (kind && offset - last >= MIN_EFFECT_GAP_SEC) {
        events.push({ t: offset, kind });
        last = offset;
      }
    }
    offset += Math.max(0, segment.end - segment.start);
  }
  return events;
}

/** Small deterministic noise source, so renders are repeatable. */
function noise(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };
}

export function synthesizeEffect(kind: SoundEffectKind, sampleRate: number): Float32Array {
  return normalizePeak(synthesizeRaw(kind, sampleRate), kind === "whoosh" ? 0.7 : 0.9);
}

function normalizePeak(samples: Float32Array, peak: number): Float32Array {
  const max = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (max > 0) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! / max) * peak;
  return samples;
}

function synthesizeRaw(kind: SoundEffectKind, sampleRate: number): Float32Array {
  if (kind === "whoosh") {
    const length = Math.round(WHOOSH_SEC * sampleRate);
    const out = new Float32Array(length);
    const rand = noise(7);
    let low = 0;
    let band = 0;
    for (let i = 0; i < length; i++) {
      const u = i / length;
      // Filter opens towards the peak and closes after it: the "air moving past" sweep.
      const peak = WHOOSH_LEAD_SEC / WHOOSH_SEC;
      const sweep = u < peak ? u / peak : 1 - (u - peak) / (1 - peak);
      const cutoff = 300 + 4200 * sweep * sweep;
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      low += (rand() - low) * a;
      band += (low - band) * 0.08; // remove some of the rumble
      const envelope = Math.sin(Math.PI * Math.pow(u, u < peak ? 1.4 : 0.8));
      out[i] = (low - band) * envelope * 0.9;
    }
    return out;
  }
  const length = Math.round(HIT_SEC * sampleRate);
  const out = new Float32Array(length);
  const rand = noise(11);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const frequency = 45 + 75 * Math.exp(-t / 0.05);
    phase += (2 * Math.PI * frequency) / sampleRate;
    const body = Math.sin(phase) * Math.exp(-t / 0.09);
    const click = t < 0.006 ? rand() * (1 - t / 0.006) * 0.5 : 0;
    out[i] = (body * 0.85 + click) * Math.min(1, t / 0.002);
  }
  return out;
}

/** Decodes an audio file (any format mediabunny reads) to planar floats, up to `maxSec`. */
export async function decodeAudioFile(file: File, startSec: number, maxSec: number): Promise<DecodedAudio> {
  const input = await createMediabunnyInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error(`"${file.name}" has no audio.`);
    if (!(await track.canDecode())) throw new Error(`"${file.name}" can't be decoded here. Try an MP3, M4A or WAV file.`);
    const chunks: Float32Array[][] = [];
    let sampleRate = 0;
    let total = 0;
    for await (const { buffer } of new AudioBufferSink(track).buffers(startSec, startSec + maxSec)) {
      sampleRate ||= buffer.sampleRate;
      const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice());
      chunks.push(channels);
      total += buffer.length;
    }
    if (!total) throw new Error(`"${file.name}" has no audio after ${Math.round(startSec)}s.`);
    const channelCount = Math.max(...chunks.map((c) => c.length));
    const channels = Array.from({ length: channelCount }, () => new Float32Array(total));
    let offset = 0;
    for (const chunk of chunks) {
      for (let c = 0; c < channelCount; c++) channels[c]!.set(chunk[c] ?? chunk[0]!, offset);
      offset += chunk[0]!.length;
    }
    return { sampleRate, channels };
  } finally {
    input.dispose();
  }
}

export interface AudioExtrasConfig {
  outputDuration: number;
  fades: Pick<ClipEdit, "fadeInSec" | "fadeOutSec">;
  music?: { audio: DecodedAudio; volume: number; duck: boolean } | null;
  effects?: { events: SoundEffectEvent[]; volume: number } | null;
}

/**
 * Returns a function that mixes music and effects into one chunk of voice audio in place.
 * Chunks must arrive in order (the ducking follows the voice level across chunks).
 */
export function createAudioExtrasMixer(config: AudioExtrasConfig, sampleRate: number) {
  const music = config.music;
  const effects = config.effects?.events.length ? config.effects : null;
  const effectSamples = new Map<SoundEffectKind, Float32Array>();
  if (effects) for (const kind of ["whoosh", "hit"] as const) effectSamples.set(kind, synthesizeEffect(kind, sampleRate));
  const envAttack = 1 - Math.exp(-1 / (0.01 * sampleRate));
  const envRelease = 1 - Math.exp(-1 / (0.3 * sampleRate));
  const duckDown = 1 - Math.exp(-1 / (DUCK_DOWN_SEC * sampleRate));
  const duckUp = 1 - Math.exp(-1 / (DUCK_UP_SEC * sampleRate));
  let envelope = 0;
  let duck = 1;
  const musicStep = music ? music.audio.sampleRate / sampleRate : 1;
  const musicLength = music ? music.audio.channels[0]!.length : 0;

  return (planar: Float32Array, channels: number, frameCount: number, firstOutputTime: number): void => {
    for (let i = 0; i < frameCount; i++) {
      const t = firstOutputTime + i / sampleRate;
      let extraL = 0;
      let extraR = 0;

      if (music && musicLength) {
        let voice = 0;
        for (let c = 0; c < channels; c++) voice = Math.max(voice, Math.abs(planar[c * frameCount + i]!));
        envelope += (voice - envelope) * (voice > envelope ? envAttack : envRelease);
        const target = music.duck && envelope > SPEECH_THRESHOLD ? DUCK_LEVEL : 1;
        duck += (target - duck) * (target < duck ? duckDown : duckUp);
        const tail = Math.min(1, Math.max(0, (config.outputDuration - t) / MUSIC_TAIL_FADE_SEC));
        const gain = music.volume * duck * tail * getFadeFactor(config.fades, t, config.outputDuration);
        // Loop the song if the clip is longer.
        const position = (t * sampleRate * musicStep) % musicLength;
        const index = Math.floor(position);
        const frac = position - index;
        const next = (index + 1) % musicLength;
        const left = music.audio.channels[0]!;
        const right = music.audio.channels[1] ?? left;
        extraL += (left[index]! * (1 - frac) + left[next]! * frac) * gain;
        extraR += (right[index]! * (1 - frac) + right[next]! * frac) * gain;
      }

      if (effects) {
        for (const event of effects.events) {
          const sound = effectSamples.get(event.kind)!;
          const start = event.t - (event.kind === "whoosh" ? WHOOSH_LEAD_SEC : 0);
          const index = Math.round((t - start) * sampleRate);
          if (index < 0 || index >= sound.length) continue;
          const value = sound[index]! * effects.volume;
          extraL += value;
          extraR += value;
        }
      }

      if (extraL === 0 && extraR === 0) continue;
      for (let c = 0; c < channels; c++) {
        const offset = c * frameCount + i;
        const extra = channels === 1 ? (extraL + extraR) / 2 : c === 0 ? extraL : c === 1 ? extraR : 0;
        planar[offset] = Math.max(-1, Math.min(1, planar[offset]! + extra));
      }
    }
  };
}
