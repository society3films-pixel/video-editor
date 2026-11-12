import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
vi.mock("../../../../shared/persistence/local-database.util", () => ({
  localRecordGet: vi.fn(),
  localRecordPut: vi.fn(),
}));
import {
  assembleTimeline,
  chooseMaster,
  classifyMedia,
  type FolderMedia,
} from "./folder-draft.util";
import { buildFolderDraftXml } from "./folder-draft-export.util";
import type { PaperEdit } from "../ai-editor/ai-paper-edit.util";

const media = (over: Partial<FolderMedia>): FolderMedia => ({
  path: `/shoot/${over.name ?? "x.mp4"}`,
  name: "x.mp4",
  hasVideo: true,
  hasAudio: true,
  durationSec: 600,
  width: 1920,
  height: 1080,
  fps: 25,
  role: "talk",
  speech: 0.7,
  music: 0,
  offsetSec: 0,
  syncScore: 1,
  ...over,
});

describe("folder draft", () => {
  it("sorts files by what they are", () => {
    expect(
      classifyMedia({
        hasVideo: false,
        hasAudio: true,
        durationSec: 900,
        speech: 0.6,
        music: 0,
      }),
    ).toBe("recorder");
    expect(
      classifyMedia({
        hasVideo: true,
        hasAudio: false,
        durationSec: 10,
        speech: 0,
        music: 0,
      }),
    ).toBe("broll");
    expect(
      classifyMedia({
        hasVideo: true,
        hasAudio: true,
        durationSec: 240,
        speech: 0.1,
        music: 0.8,
      }),
    ).toBe("performance");
    expect(
      classifyMedia({
        hasVideo: true,
        hasAudio: true,
        durationSec: 1800,
        speech: 0.6,
        music: 0.1,
      }),
    ).toBe("talk");
    expect(
      classifyMedia({
        hasVideo: true,
        hasAudio: true,
        durationSec: 20,
        speech: 0.6,
        music: 0,
      }),
    ).toBe("broll");
  });

  it("uses a sound recorder as the master, else the talkiest camera", () => {
    const camA = media({ name: "A.mp4" });
    const camB = media({ name: "B.mp4", durationSec: 900 });
    const rec = media({ name: "zoom.wav", hasVideo: false, role: "recorder" });
    expect(chooseMaster([camA, camB, rec])).toBe(rec);
    expect(chooseMaster([camA, camB])).toBe(camB);
  });

  it("builds a timeline: cameras alternate, sound from the master, named B-roll where it's said, performances whole", () => {
    const rec = media({ name: "zoom.wav", hasVideo: false, role: "recorder" });
    const camA = media({ name: "A.mp4", offsetSec: 2 });
    const camB = media({ name: "B.mp4", offsetSec: -1 });
    const guitar = media({
      name: "guitar_closeup.mp4",
      role: "broll",
      hasAudio: false,
      durationSec: 12,
      offsetSec: null,
    });
    const song = media({
      name: "song.mp4",
      role: "performance",
      durationSec: 180,
      offsetSec: null,
    });
    const story: PaperEdit = {
      title: "t",
      durationSec: 0,
      parts: [
        {
          title: "Intro",
          startSec: 10,
          endSec: 40,
          wordStartIdx: 0,
          wordEndIdx: 1,
          kind: "talk",
        },
        {
          title: "Song",
          startSec: 0,
          endSec: 0,
          wordStartIdx: 0,
          wordEndIdx: 0,
          kind: "performance",
          performanceId: "P1",
        },
        {
          title: "Gear",
          startSec: 100,
          endSec: 130,
          wordStartIdx: 2,
          wordEndIdx: 3,
          kind: "talk",
        },
      ],
    };
    const words = [
      { text: "my", start: 105, end: 105.3 },
      { text: "guitar", start: 105.3, end: 105.8 },
    ];
    const t = assembleTimeline(
      story,
      [rec, camA, camB, guitar, song],
      rec,
      words,
      new Map([["P1", song]]),
    );
    expect(t.durationSec).toBe(30 + 180 + 30);
    expect(t.video.map((c) => c.media.name)).toEqual([
      "A.mp4",
      "song.mp4",
      "B.mp4",
    ]);
    expect(t.video[0]).toMatchObject({ inSec: 8, outSec: 38, startSec: 0 });
    expect(t.video[2]).toMatchObject({
      inSec: 101,
      outSec: 131,
      startSec: 210,
    });
    expect(t.audio.map((c) => c.media.name)).toEqual([
      "zoom.wav",
      "song.mp4",
      "zoom.wav",
    ]);
    expect(t.broll).toHaveLength(1);
    expect(t.broll[0]!.media.name).toBe("guitar_closeup.mp4");
    expect(t.broll[0]!.startSec).toBeCloseTo(210 + 5.3 - 0.2, 5);

    const xml = buildFolderDraftXml("draft & test", t, {
      width: 1920,
      height: 1080,
      fps: 25,
    });
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("draft &amp; test");
    // Every opened element is closed, in order.
    const stack: string[] = [];
    for (const [, close, tag, selfClose] of xml
      .replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, "")
      .matchAll(/<(\/?)([A-Za-z_][\w-]*)[^>]*?(\/?)>/g)) {
      if (selfClose) continue;
      if (close) expect(stack.pop()).toBe(tag);
      else stack.push(tag!);
    }
    expect(stack).toEqual([]);
    expect(xml.match(/<clipitem/g)).toHaveLength(
      t.video.length + t.broll.length + t.audio.length,
    );
  });
});
