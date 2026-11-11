import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
import { buildPremiereXml, buildSrt, frameRateFor, pathUrl } from "./premiere-export.util";

describe("Premiere export", () => {
  it("maps frame rates", () => {
    expect(frameRateFor(29.97)).toEqual({ timebase: 30, ntsc: true });
    expect(frameRateFor(25.0)).toEqual({ timebase: 25, ntsc: false });
    expect(frameRateFor(59.9)).toEqual({ timebase: 60, ntsc: true });
  });
  it("builds file URLs Premiere accepts", () => {
    expect(pathUrl("C:\\Users\\Me\\My Clips\\a b.mp4")).toBe("file://localhost/C:/Users/Me/My%20Clips/a%20b.mp4");
    expect(pathUrl("/home/me/clip.mp4")).toBe("file://localhost/home/me/clip.mp4");
  });
  it("lays the parts end to end, hook first, with linked audio and music", () => {
    const xml = buildPremiereXml({
      name: "Clip & co",
      width: 1080,
      height: 1920,
      rate: { timebase: 30, ntsc: false },
      video: { name: "c.mp4", path: "C:/x/c.mp4", durationSec: 20 },
      parts: [
        { start: 10, end: 12 },
        { start: 0, end: 5 },
        { start: 8, end: 15 },
      ],
      music: { name: "m.mp3", path: "C:/x/m.mp3", durationSec: 120, startSec: 30 },
    });
    expect(xml).toContain("<name>Clip &amp; co</name><duration>420</duration>");
    expect(xml).toContain('<clipitem id="clipitem-v1"><name>c.mp4</name><enabled>TRUE</enabled><duration>600</duration>');
    expect(xml).toMatch(/clipitem-v1.*?<start>0<\/start><end>60<\/end><in>300<\/in><out>360<\/out>/);
    expect(xml).toMatch(/clipitem-v2.*?<start>60<\/start><end>210<\/end><in>0<\/in><out>150<\/out>/);
    expect(xml).toMatch(/clipitem-a3.*?<start>210<\/start><end>420<\/end><in>240<\/in><out>450<\/out>/);
    expect(xml).toMatch(/clipitem-music.*?<start>0<\/start><end>420<\/end><in>900<\/in><out>1320<\/out>/);
    expect(xml.match(/<file id="file-1">/g)).toHaveLength(1);
    expect(xml).toContain("<pathurl>file://localhost/C:/x/c.mp4</pathurl>");
  });
  it("writes captions on the edited timeline", () => {
    const groups = [
      { words: [{ text: "cut", start: 1, end: 1.5 }], start: 1, end: 1.5 },
      { words: [{ text: "hello", start: 6, end: 6.5 }, { text: "world", start: 6.5, end: 7 }], start: 6, end: 7 },
    ];
    const srt = buildSrt(groups, { segments: [{ id: "a", start: 0, end: 0.5 }, { id: "b", start: 5, end: 10 }], hook: { start: 6, end: 7, text: "x" } });
    expect(srt).toBe("1\n00:00:02,500 --> 00:00:03,500\nhello world\n");
  });
});

import { buildFcpxml } from "./premiere-export.util";
describe("Final Cut Pro export", () => {
  it("writes frame-exact asset clips with the music connected below", () => {
    const xml = buildFcpxml({
      name: "c",
      width: 1080,
      height: 1920,
      rate: { timebase: 30, ntsc: true },
      video: { name: "c.mp4", path: "C:/x/c.mp4", durationSec: 20 },
      parts: [{ start: 10, end: 12 }, { start: 0, end: 5 }],
      music: { name: "m.mp3", path: "C:/x/m.mp3", durationSec: 60, startSec: 0 },
    });
    expect(xml).toContain('frameDuration="1001/30000s"');
    expect(xml).toContain('src="file:///C:/x/c.mp4"');
    expect(xml).toMatch(/<asset-clip ref="r2" offset="0\/30000s" start="300300\/30000s" duration="60060\/30000s"/);
    expect(xml).toMatch(/<asset-clip ref="r3" lane="-1"/);
    expect(xml).toContain('<sequence format="r1" duration="210210/30000s"');
  });
});
