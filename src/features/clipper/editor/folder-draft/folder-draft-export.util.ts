/** The folder draft as files: a Premiere / Resolve (FCP7 XML) timeline and an .srt of what's said. */
import { frameRateFor, pathUrl, type FrameRate } from "../premiere-export.util";
import { srtTimestamp } from "../../lib/captions/srt.util";
import type { WordCue } from "../../lib/media/transcription-export.util";
import type { PaperEdit } from "../ai-editor/ai-paper-edit.util";
import type {
  DraftTimeline,
  FolderMedia,
  TimelineClip,
} from "./folder-draft.util";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fpsOf(rate: FrameRate): number {
  return rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
}

export function buildFolderDraftXml(
  name: string,
  timeline: DraftTimeline,
  sequence: { width: number; height: number; fps: number },
): string {
  const rate = frameRateFor(sequence.fps);
  const fps = fpsOf(rate);
  const frames = (sec: number) => Math.round(sec * fps);
  const rateXml = `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
  const fileIds = new Map<string, string>();
  const fileXml = (media: FolderMedia) => {
    const known = fileIds.get(media.path);
    if (known) return `<file id="${known}"/>`;
    const id = `file-${fileIds.size + 1}`;
    fileIds.set(media.path, id);
    const video = media.hasVideo
      ? `<video><samplecharacteristics>${rateXml}<width>${media.width}</width><height>${media.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>`
      : "";
    const audio = media.hasAudio
      ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`
      : "";
    return `<file id="${id}"><name>${escapeXml(media.name)}</name><pathurl>${escapeXml(pathUrl(media.path))}</pathurl>${rateXml}<duration>${frames(media.durationSec)}</duration><media>${video}${audio}</media></file>`;
  };
  let counter = 0;
  const item = (
    clip: TimelineClip,
    kind: "video" | "audio",
    enabled = true,
  ) => {
    counter++;
    const start = frames(clip.startSec);
    const inFrame = Math.max(0, frames(clip.inSec));
    const length = Math.max(1, frames(clip.outSec) - inFrame);
    return (
      `<clipitem id="clipitem-${counter}"><name>${escapeXml(clip.label || clip.media.name)}</name><enabled>${enabled ? "TRUE" : "FALSE"}</enabled><duration>${frames(clip.media.durationSec)}</duration>${rateXml}` +
      `<start>${start}</start><end>${start + length}</end><in>${inFrame}</in><out>${inFrame + length}</out>${fileXml(clip.media)}` +
      (kind === "audio"
        ? `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>`
        : "") +
      `</clipitem>`
    );
  };
  const track = (
    clips: TimelineClip[],
    kind: "video" | "audio",
    enabled = true,
  ) => `<track>${clips.map((c) => item(c, kind, enabled)).join("")}</track>`;
  const markers = timeline.markers
    .map(
      (m) =>
        `<marker><name>${escapeXml(m.title)}</name><comment></comment><in>${frames(m.startSec)}</in><out>-1</out></marker>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1"><name>${escapeXml(name)}</name><duration>${frames(timeline.durationSec)}</duration>${rateXml}${markers}` +
    `<media><video><format><samplecharacteristics>${rateXml}<width>${sequence.width}</width><height>${sequence.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>` +
    `${track(timeline.video, "video")}${timeline.broll.length ? track(timeline.broll, "video") : ""}</video>` +
    `<audio>${track(timeline.audio, "audio")}${timeline.scratch.length ? track(timeline.scratch, "audio", false) : ""}</audio></media></sequence></xmeml>\n`
  );
}

/** What's said in each talking part as caption lines, on the draft timeline's clock. */
export function draftCaptions(
  story: PaperEdit,
  words: readonly WordCue[],
): Array<{ start: number; end: number; text: string }> {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  for (const part of story.parts) {
    if (part.kind === "talk") {
      const partWords = words.filter(
        (w) =>
          !w.deleted &&
          w.start >= part.startSec - 0.01 &&
          w.end <= part.endSec + 0.01,
      );
      for (let i = 0; i < partWords.length; i += 7) {
        const line = partWords.slice(i, i + 7);
        const start = cursor + line[0]!.start - part.startSec;
        const end = cursor + line[line.length - 1]!.end - part.startSec;
        lines.push({
          start,
          end: Math.max(start + 0.3, end),
          text: line.map((w) => w.text).join(" "),
        });
      }
    }
    cursor += part.endSec - part.startSec;
  }
  return lines;
}

export function buildFolderDraftSrt(
  story: PaperEdit,
  words: readonly WordCue[],
): string {
  return draftCaptions(story, words)
    .map(
      (c, i) =>
        `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`,
    )
    .join("\n");
}
