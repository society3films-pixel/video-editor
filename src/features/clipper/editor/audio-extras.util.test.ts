import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { createAudioExtrasMixer, DUCK_LEVEL, soundEffectEvents, synthesizeEffect } from "./audio-extras.util";
import { clipEditNeedsPostProcess, createInitialClipEdit } from "./clip-edit.util";
import { fromPersistedClipEdit, toPersistedClipEdit } from "./clip-edit-persist.util";

describe("soundEffectEvents", () => {
  it("puts a whoosh on jumps, a hit on punch-ins, and spaces them out", () => {
    const segments = [
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 3, end: 5, zoom: 1.15 },
      { id: "c", start: 5.5, end: 6 },
      { id: "d", start: 7, end: 9 },
    ];
    expect(soundEffectEvents(segments, { cuts: true, punchIns: true })).toEqual([
      { t: 2, kind: "hit" },
      { t: 4, kind: "whoosh" },
    ]);
    expect(soundEffectEvents(segments, { cuts: false, punchIns: true })).toEqual([{ t: 2, kind: "hit" }]);
  });
  it("synthesizes bounded sounds", () => {
    for (const kind of ["whoosh", "hit"] as const) {
      const sound = synthesizeEffect(kind, 48000);
      const peak = sound.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(1);
    }
  });
});

describe("createAudioExtrasMixer", () => {
  const sampleRate = 1000;
  const music = { sampleRate, channels: [new Float32Array(1000).fill(0.5)] };
  it("ducks the music under speech and restores it in silence", () => {
    const mix = createAudioExtrasMixer({ outputDuration: 100, fades: { fadeInSec: 0, fadeOutSec: 0 }, music: { audio: music, volume: 1, duck: true } }, sampleRate);
    const speech = new Float32Array(2000).fill(0.3);
    mix(speech, 1, 2000, 0);
    // After 2 s of speech the music sits at the ducked level on top of the voice.
    expect(speech[1999]! - 0.3).toBeCloseTo(0.5 * DUCK_LEVEL, 2);
    const silence = new Float32Array(4000);
    mix(silence, 1, 4000, 2);
    expect(silence[3999]).toBeCloseTo(0.5, 2);
  });
  it("leaves the music alone with ducking off", () => {
    const mix = createAudioExtrasMixer({ outputDuration: 100, fades: { fadeInSec: 0, fadeOutSec: 0 }, music: { audio: music, volume: 0.5, duck: false } }, sampleRate);
    const speech = new Float32Array(2000).fill(0.3);
    mix(speech, 1, 2000, 0);
    expect(speech[1999]).toBeCloseTo(0.55, 3);
  });
});

describe("edit extras", () => {
  it("need a re-render and survive saving", () => {
    const edit = {
      ...createInitialClipEdit(10),
      music: { assetId: "asset-1", name: "song.mp3", volume: 0.3, duck: true, startSec: 12 },
      sfx: { cuts: true, punchIns: false, volume: 0.5 },
      progressBar: { position: "top" as const, color: "#ff0000", thickness: 0.01 },
      cover: { time: 2.5, title: "Big news", firstFrames: true },
    };
    expect(clipEditNeedsPostProcess(createInitialClipEdit(10), 10)).toBe(false);
    expect(clipEditNeedsPostProcess(edit, 10)).toBe(true);
    const restored = fromPersistedClipEdit(JSON.parse(JSON.stringify(toPersistedClipEdit(edit))), 10)!;
    expect(restored.music).toEqual(edit.music);
    expect(restored.sfx).toEqual(edit.sfx);
    expect(restored.progressBar).toEqual(edit.progressBar);
    expect(restored.cover).toEqual(edit.cover);
  });
});
