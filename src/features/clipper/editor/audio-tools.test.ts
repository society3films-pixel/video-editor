import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { beatPulseZoom, beatsOnTimeline, detectBeats } from "./beat-sync.util";
import { VoiceCleanup } from "./voice-cleanup.util";
import { planPauseCuts } from "./auto-edit.util";

describe("beat sync", () => {
  it("finds 120 BPM in a click track", () => {
    const rate = 8000;
    const data = new Float32Array(rate * 10);
    for (let beat = 0.25; beat < 10; beat += 0.5) {
      const start = Math.round(beat * rate);
      for (let i = 0; i < 400; i++) data[start + i] = Math.sin(i * 0.3) * Math.exp(-i / 80);
    }
    const found = detectBeats({ sampleRate: rate, channels: [data] })!;
    expect(found.bpm).toBeGreaterThan(115);
    expect(found.bpm).toBeLessThan(125);
    expect(Math.abs((found.beats[0]! % 0.5) - 0.25)).toBeLessThan(0.03);
  });
  it("places beats on the timeline and pulses after them", () => {
    expect(beatsOnTimeline([0.5, 1.5], 0, 2, 4)).toEqual([0.5, 1.5, 2.5, 3.5]);
    const pulse = { beats: [1, 2], strength: 0.04, every: 1 as const, bpm: 60 };
    expect(beatPulseZoom(pulse, 0.9)).toBe(1);
    expect(beatPulseZoom(pulse, 1.05)).toBeGreaterThan(1.02);
    expect(beatPulseZoom(pulse, 1.5)).toBe(1);
  });
});

describe("voice clean-up", () => {
  it("pushes down steady background noise but keeps speech", () => {
    const rate = 16000;
    const cleanup = new VoiceCleanup({ denoise: true, compress: false }, rate);
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
    const quiet = Float32Array.from({ length: rate * 2 }, noise);
    cleanup.process(quiet, 1, quiet.length);
    const rms = (a: Float32Array, from: number) => Math.sqrt(a.subarray(from).reduce((s, v) => s + v * v, 0) / (a.length - from));
    expect(rms(quiet, rate)).toBeLessThan(0.0058 * 0.4);
    const speech = Float32Array.from({ length: rate }, (_, i) => Math.sin((i / rate) * 2 * Math.PI * 220) * 0.3);
    cleanup.process(speech, 1, speech.length);
    expect(rms(speech, rate / 2)).toBeGreaterThan(0.18);
  });
});

describe("tighter conversation", () => {
  it("cuts gaps at a change of speaker shorter", () => {
    const words = [
      { text: "so", start: 0, end: 0.3 },
      { text: "yes", start: 0.7, end: 1.0 },
      { text: "and", start: 1.4, end: 1.7 },
    ];
    const loose = planPauseCuts(words, 2)!;
    expect(loose.segments).toHaveLength(1);
    const tight = planPauseCuts(words, 2, { maxPauseSec: 0.45, leadSec: 0.1, tailSec: 0.18, removeFillers: true, turnBoundaries: [0.5] })!;
    expect(tight.segments).toHaveLength(2);
    expect(tight.segments[1]!.start - tight.segments[0]!.end).toBeGreaterThan(0.2);
  });
});
