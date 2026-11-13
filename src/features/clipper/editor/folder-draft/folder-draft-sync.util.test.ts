import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../../shared/utils/platform.util", () => ({
  isTauri: () => false,
}));

import { correlatePeaks } from "../correlate.util";
import {
  fileTimeOf,
  masterTimeOf,
  syncFeature,
  syncItem,
} from "./folder-draft-sync.util";
import type { FolderMedia } from "./folder-draft.util";

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** 20 ms levels of a fake interview: syllables and pauses, `seconds` long. */
function speechLevels(seconds: number, seed: number): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds / 0.02));
  let i = 0;
  while (i < out.length) {
    const talk = rand() < 0.8;
    const len = Math.round(talk ? 4 + rand() * 12 : 3 + rand() * 30);
    for (let k = 0; k < len && i < out.length; k++, i++)
      out[i] = talk ? 0.05 + rand() * 0.25 : 0.003 + rand() * 0.003;
  }
  return out;
}

/** What another microphone hears of `master` from master time `start` for `seconds`: other gain, noise, a clock that runs `drift` fast. */
function hear(
  master: Float32Array,
  start: number,
  seconds: number,
  gain: number,
  drift: number,
  seed: number,
): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(seconds / 0.02));
  for (let i = 0; i < out.length; i++) {
    const masterIndex = Math.round((start + i * 0.02 * (1 + drift)) / 0.02);
    const v = master[masterIndex] ?? 0.004;
    out[i] = v * gain * (0.8 + rand() * 0.4) + 0.002 * rand();
  }
  return out;
}

const media = (over: Partial<FolderMedia>): FolderMedia => ({
  path: "/x",
  name: "x",
  hasVideo: true,
  hasAudio: true,
  durationSec: 0,
  width: 1920,
  height: 1080,
  fps: 25,
  role: "talk",
  speech: 0.7,
  music: 0,
  offsetSec: 0,
  drift: 0,
  syncScore: 1,
  ...over,
});

describe("sync", () => {
  it("FFT correlation finds the same lag as a direct search", () => {
    const rand = rng(3);
    const target = Float32Array.from({ length: 3000 }, () => rand() - 0.5);
    const reference = target.slice(1234, 1734);
    expect(correlatePeaks(reference, target)[0]).toMatchObject({ lag: 1234 });
    expect(correlatePeaks(reference, target)[0]!.score).toBeCloseTo(1, 5);
  });

  it("lines up a camera that starts 2 minutes into the interview, at another gain, with noise", () => {
    const masterLevels = speechLevels(1800, 1);
    const camera = hear(masterLevels, 123.44, 1500, 0.3, 0, 2);
    const result = syncItem(
      syncFeature(camera),
      [{ media: media({ name: "rec" }), feature: syncFeature(masterLevels) }],
      null,
    );
    expect(result).not.toBeNull();
    expect(Math.abs(result!.offsetSec - 123.44)).toBeLessThan(0.05);
    expect(result!.agreed).toBeGreaterThanOrEqual(3);
  });

  it("measures clock drift over a long recording", () => {
    const masterLevels = speechLevels(2600, 4);
    const drift = 8e-5; // 80 ppm: 0.2 s over 40 minutes
    const camera = hear(masterLevels, 30, 2400, 0.5, drift, 5);
    const result = syncItem(
      syncFeature(camera),
      [{ media: media({}), feature: syncFeature(masterLevels) }],
      null,
    )!;
    expect(result.drift).toBeGreaterThan(5e-5);
    expect(result.drift).toBeLessThan(11e-5);
    const camMedia = media({
      offsetSec: result.offsetSec,
      drift: result.drift,
    });
    // The end of the recording lands within a frame of the truth.
    expect(
      Math.abs(masterTimeOf(camMedia, 2300) - (30 + 2300 * (1 + drift))),
    ).toBeLessThan(0.04);
    expect(fileTimeOf(camMedia, masterTimeOf(camMedia, 1000))).toBeCloseTo(
      1000,
      6,
    );
  });

  it("doesn't trust a file that matches nothing, but uses timecode when there is one", () => {
    const masterLevels = speechLevels(900, 6);
    const unrelated = speechLevels(600, 99);
    const refs = [{ media: media({}), feature: syncFeature(masterLevels) }];
    expect(syncItem(syncFeature(unrelated), refs, null)).toBeNull();
    expect(syncItem(syncFeature(unrelated), refs, 42)).toMatchObject({
      offsetSec: 42,
      method: "timecode",
    });
  });
});
