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
  mergeWords,
  assignCameraGroups,
  roleFromFolder,
  classifyWithFolder,
  planShots,
  trimStoryPart,
  cutStoryPart,
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
    // Camera sound goes on a muted scratch track; one marker per part.
    expect(t.scratch.map((c) => c.media.name)).toEqual(["A.mp4", "B.mp4"]);
    expect(t.markers.map((m) => m.startSec)).toEqual([0, 30, 210]);
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
      t.video.length + t.broll.length + t.audio.length + t.scratch.length + t.angles.reduce((n, a) => n + a.clips.length, 0),
    );
  });

  it("uses whichever recorder file covers a part, and the camera's sound where none does", () => {
    const rec1 = media({
      name: "ZOOM0001.wav",
      hasVideo: false,
      role: "recorder",
      durationSec: 600,
      offsetSec: 0,
    });
    const rec2 = media({
      name: "ZOOM0002.wav",
      hasVideo: false,
      role: "recorder",
      durationSec: 600,
      offsetSec: 600,
    });
    const cam = media({ name: "A.mp4", durationSec: 1500, offsetSec: -30 });
    const part = (startSec: number, endSec: number) => ({
      title: "p",
      startSec,
      endSec,
      wordStartIdx: 0,
      wordEndIdx: 0,
      kind: "talk" as const,
    });
    const story: PaperEdit = {
      title: "t",
      durationSec: 0,
      parts: [part(100, 120), part(700, 720), part(1300, 1320)],
    };
    const t = assembleTimeline(story, [rec1, rec2, cam], rec1, [], new Map(), {
      noBroll: true,
    });
    expect(t.audio.map((c) => c.media.name)).toEqual([
      "ZOOM0001.wav",
      "ZOOM0002.wav",
      "A.mp4",
    ]);
    expect(t.audio[1]).toMatchObject({ inSec: 100, outSec: 120 });
    expect(t.audio[2]).toMatchObject({ inSec: 1330, outSec: 1350 });
  });

  it("merges transcripts of split recordings on one clock", () => {
    const w = (text: string, start: number) => ({
      text,
      start,
      end: start + 0.5,
    });
    const words = mergeWords([
      { offsetSec: 0, words: [w("a", 1), w("b", 590)] },
      { offsetSec: 600, words: [w("c", 1), w("d", 5)] },
    ]);
    expect(words.map((x) => [x.text, x.start])).toEqual([
      ["a", 1],
      ["b", 590],
      ["c", 601],
      ["d", 605],
    ]);
  });

  it("cuts to whoever is talking at sentence ends, and for variety when it's unclear", () => {
    const host = media({ name: "host.mp4" });
    const guest = media({ name: "guest.mp4" });
    // Sentences: 0-5 (guest), 5-10 (host asks), 10-20 (guest).
    const words = [
      { text: "I", start: 0.2, end: 0.5 },
      { text: "started.", start: 4, end: 4.8 },
      { text: "Why?", start: 5.2, end: 9.6 },
      { text: "Because", start: 10.2, end: 11 },
      { text: "music.", start: 18, end: 19.8 },
    ];
    const bins = (fn: (t: number) => number) => [
      {
        start: 0,
        step: 0.5,
        values: Array.from({ length: 40 }, (_, k) => fn(k * 0.5)),
      },
    ];
    const activity = {
      [guest.path]: bins((t) => (t < 5 || t >= 10 ? 8 : 1)),
      [host.path]: bins((t) => (t >= 5 && t < 10 ? 8 : 1)),
    };
    const shots = planShots(0, 20, [host, guest], words, activity, 0);
    expect(
      shots.map((s) => [
        s.camera.name,
        Number(s.a.toFixed(2)),
        Number(s.b.toFixed(2)),
      ]),
    ).toEqual([
      ["guest.mp4", 0, 5],
      ["host.mp4", 5, 9.9],
      ["guest.mp4", 9.9, 20],
    ]);
    // No analysis: one camera until the variety interval, then the next at a sentence break.
    const long = Array.from({ length: 10 }, (_, i) => ({
      text: "Yes.",
      start: i * 4,
      end: i * 4 + 3,
    }));
    const plain = planShots(0, 40, [host, guest], long, undefined, 0);
    expect(plain.length).toBeGreaterThan(1);
    expect(plain.every((s) => s.b - s.a >= 2.5)).toBe(true);
  });

  it("trims and cuts words inside a talking part", () => {
    const words = Array.from({ length: 10 }, (_, i) => ({
      text: `w${i}`,
      start: i,
      end: i + 0.8,
    }));
    const story: PaperEdit = {
      title: "t",
      durationSec: 0,
      parts: [
        {
          title: "A",
          startSec: 0,
          endSec: 9.8,
          wordStartIdx: 0,
          wordEndIdx: 9,
          kind: "talk",
        },
      ],
    };
    expect(trimStoryPart(story, 0, 2, 5, words).parts[0]).toMatchObject({
      startSec: 2,
      endSec: 5.8,
      wordStartIdx: 2,
      wordEndIdx: 5,
    });
    const cut = cutStoryPart(story, 0, 3, 4, words);
    expect(cut.replacedBy).toBe(2);
    expect(cut.story.parts.map((p) => [p.startSec, p.endSec])).toEqual([
      [0, 2.8],
      [5, 9.8],
    ]);
    expect(cutStoryPart(story, 0, 0, 9, words).replacedBy).toBe(0);
  });

  it("uses folder names to sort files", () => {
    expect(roleFromFolder("Audio/Zoom")).toBe("recorder");
    expect(roleFromFolder("Video/B-Roll/Guitar shop")).toBe("broll");
    expect(roleFromFolder("Video/Cam A")).toBe("talk");
    expect(roleFromFolder("Interview session")).toBe("talk");
    expect(roleFromFolder("Live songs")).toBe("performance");
    expect(roleFromFolder("Video")).toBeNull();
    const camWithMusic = {
      hasVideo: true,
      hasAudio: true,
      durationSec: 30,
      speech: 0.1,
      music: 0.2,
    };
    expect(classifyWithFolder(camWithMusic, "Cam B")).toBe("talk");
    expect(classifyWithFolder(camWithMusic, "Performances")).toBe(
      "performance",
    );
    // A hint that doesn't fit the file is ignored: a video can't be the sound recorder.
    expect(
      classifyWithFolder(
        { ...camWithMusic, durationSec: 120, speech: 0.6 },
        "Audio",
      ),
    ).toBe("talk");
  });

  it("groups a camera's stop-start clips and gives each camera its own (switched-off) track", () => {
    const files = [
      media({
        name: "A001C001.mp4",
        folder: "Video/Sony FX3",
        offsetSec: 0,
        durationSec: 300,
      }),
      media({
        name: "A001C002.mp4",
        folder: "Video/Sony FX3",
        offsetSec: 300,
        durationSec: 300,
      }),
      media({
        name: "GX010001.MP4",
        folder: "Video",
        offsetSec: 0,
        durationSec: 600,
      }),
      media({
        name: "GX010002.MP4",
        folder: "Video",
        offsetSec: 600,
        durationSec: 100,
      }),
      media({
        name: "zoom.wav",
        hasVideo: false,
        role: "recorder",
        offsetSec: 0,
        durationSec: 700,
      }),
    ];
    assignCameraGroups(files);
    expect(files.map((f) => f.group)).toEqual([
      "Sony FX3",
      "Sony FX3",
      "Cam A",
      "Cam A",
      undefined,
    ]);
    const part = (startSec: number, endSec: number) => ({
      title: "p",
      startSec,
      endSec,
      wordStartIdx: 0,
      wordEndIdx: 0,
      kind: "talk" as const,
    });
    const story: PaperEdit = {
      title: "t",
      durationSec: 0,
      parts: [part(100, 120), part(400, 420)],
    };
    const t = assembleTimeline(story, files, files[4]!, [], new Map(), {
      noBroll: true,
    });
    expect(
      t.angles.map((a) => [a.label, a.clips.map((c) => c.media.name)]),
    ).toEqual([
      ["Cam A", ["GX010001.MP4", "GX010001.MP4"]],
      ["Sony FX3", ["A001C001.mp4", "A001C002.mp4"]],
    ]);
    expect(t.angles[1]!.clips[1]).toMatchObject({ inSec: 100, startSec: 20 });
    const xml = buildFolderDraftXml("x", t, {
      width: 1920,
      height: 1080,
      fps: 25,
    });
    // V1 cuts + two camera tracks, each switched off.
    expect(xml.match(/<track>/g)!.length).toBe(
      1 + 2 + 1 + (t.scratch.length ? 1 : 0),
    );
    expect(xml.match(/<enabled>FALSE<\/enabled>/g)!.length).toBe(
      4 + t.scratch.length,
    );
  });
});
