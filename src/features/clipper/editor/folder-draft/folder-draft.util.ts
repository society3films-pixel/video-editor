/**
 * Folder → draft: every file from a shoot (interview cameras, a separate recorder, performance
 * takes, B-roll) is sorted, lined up by sound against one master recording, the master is
 * transcribed, the AI builds a story, and the result is an editable multi-camera timeline.
 * Everything runs on this computer (the AI can be a local model).
 */
import { invoke } from "@tauri-apps/api/core";
import { createMediabunnyInput } from "../../lib/media/mediabunny-file-source.util";
import type { WordCue } from "../../lib/media/transcription-export.util";
import { pathBackedFile } from "../../platform/native-source.util";
import { frameLevels, musicSectionsFromLevels } from "../music-detect.util";
import { bestLag, envelopeFromLevels } from "../multicam.util";
import { tagsFromName } from "../broll-library.util";
import type { PaperEdit } from "../ai-editor/ai-paper-edit.util";

export type FolderMediaRole = "talk" | "performance" | "broll" | "recorder";

export interface FolderMedia {
  path: string;
  name: string;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  role: FolderMediaRole;
  /** Shares of the recording (0..1). */
  speech: number;
  music: number;
  /** Where this file's t=0 sits on the master's clock; null = not lined up. */
  offsetSec: number | null;
  syncScore: number;
}

interface ListedFile {
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
}

const AUDIO_ONLY = /\.(wav|mp3|m4a|aac|flac|aiff?|ogg)$/i;
const SILENCE_RMS = 0.004;
const MIN_SYNC_SCORE = 0.35;

export function listShootFolder(dir: string): Promise<ListedFile[]> {
  return invoke<ListedFile[]>("list_media_files", { dir });
}

function mimeFor(name: string): string {
  if (/\.wav$/i.test(name)) return "audio/wav";
  if (/\.mp3$/i.test(name)) return "audio/mpeg";
  if (AUDIO_ONLY.test(name)) return "audio/mp4";
  if (/\.mov$/i.test(name)) return "video/quicktime";
  return "video/mp4";
}

export function fileFor(media: Pick<FolderMedia, "path" | "name">): File {
  return pathBackedFile(media.path, media.name, mimeFor(media.name));
}

/** Shares of speech, music and silence from 20 ms levels. */
export function soundProfile(levels: Float32Array): {
  speech: number;
  music: number;
  silent: number;
} {
  const seconds = Math.floor(levels.length / 50);
  if (!seconds) return { speech: 0, music: 0, silent: 1 };
  let silent = 0;
  for (let s = 0; s < seconds; s++) {
    let sum = 0;
    for (let i = 0; i < 50; i++) sum += levels[s * 50 + i]!;
    if (sum / 50 < SILENCE_RMS) silent++;
  }
  const musicSec = musicSectionsFromLevels(levels, []).reduce(
    (sum, m) => sum + (m.end - m.start),
    0,
  );
  const music = Math.min(1, musicSec / seconds);
  return {
    speech: Math.max(0, 1 - music - silent / seconds),
    music,
    silent: silent / seconds,
  };
}

/** Talk, performance, B-roll or separate recorder, from what the file is and how it sounds. */
export function classifyMedia(item: {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
  speech: number;
  music: number;
}): FolderMediaRole {
  if (!item.hasVideo) return "recorder";
  if (!item.hasAudio) return "broll";
  if (item.music >= 0.5) return "performance";
  if (item.speech >= 0.3 && item.durationSec >= 60) return "talk";
  return "broll";
}

async function probe(path: string, name: string) {
  const input = await createMediabunnyInput(
    pathBackedFile(path, name, mimeFor(name)),
  );
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const stats = video
      ? await video.computePacketStats(90).catch(() => null)
      : null;
    return {
      durationSec: await input.computeDuration(),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      width: video?.displayWidth ?? 0,
      height: video?.displayHeight ?? 0,
      fps: stats?.averagePacketRate || 30,
    };
  } finally {
    input.dispose();
  }
}

/** The recording everything is lined up to: a separate recorder if there is one, else the talkiest camera. */
export function chooseMaster(
  items: readonly FolderMedia[],
): FolderMedia | null {
  const score = (m: FolderMedia) => m.durationSec * (m.speech + m.music * 0.5);
  const recorders = items.filter((m) => m.role === "recorder" && m.hasAudio);
  if (recorders.length)
    return [...recorders].sort((a, b) => score(b) - score(a))[0]!;
  const talk = items.filter((m) => m.role === "talk");
  if (talk.length) return [...talk].sort((a, b) => score(b) - score(a))[0]!;
  return (
    [...items]
      .filter((m) => m.hasAudio)
      .sort((a, b) => b.durationSec - a.durationSec)[0] ?? null
  );
}

export interface AnalyzeProgress {
  (step: string, ratio: number): void;
}

/** Sorts the folder's files and lines up everything with sound against the master. */
export async function analyzeShoot(
  dir: string,
  onProgress: AnalyzeProgress,
): Promise<{ items: FolderMedia[]; master: FolderMedia | null }> {
  const listed = await listShootFolder(dir);
  if (!listed.length)
    throw new Error("There are no video or audio files in this folder.");
  const items: FolderMedia[] = [];
  const envelopes = new Map<string, Float32Array>();
  for (const [index, file] of listed.entries()) {
    onProgress(`Listening to ${file.name}`, index / listed.length);
    const info = await probe(file.path, file.name).catch(() => null);
    if (!info) continue;
    let profile = { speech: 0, music: 0, silent: 1 };
    if (info.hasAudio) {
      const levels = await frameLevels(
        fileFor({ path: file.path, name: file.name }),
      );
      profile = soundProfile(levels);
      envelopes.set(file.path, envelopeFromLevels(levels));
    }
    const base = { ...info, speech: profile.speech, music: profile.music };
    items.push({
      path: file.path,
      name: file.name,
      ...base,
      role: classifyMedia(base),
      offsetSec: null,
      syncScore: 0,
    });
  }
  const master = chooseMaster(items);
  if (!master) return { items, master: null };
  master.offsetSec = 0;
  master.syncScore = 1;
  const masterEnvelope = envelopes.get(master.path)!;
  const step = 0.04; // envelope frames (see multicam.util)
  const others = items.filter((m) => m !== master && envelopes.has(m.path));
  for (const [index, item] of others.entries()) {
    onProgress(`Lining up ${item.name}`, index / Math.max(1, others.length));
    const envelope = envelopes.get(item.path)!;
    // Up to two minutes from a tenth of the way in (past any slate or silence at the start).
    const from = Math.floor(envelope.length * 0.1);
    const length = Math.min(Math.round(120 / step), envelope.length - from);
    if (length < 150) continue;
    const { lag, score } = bestLag(
      envelope.slice(from, from + length),
      masterEnvelope,
    );
    item.syncScore = Math.max(0, score);
    if (score >= MIN_SYNC_SCORE) item.offsetSec = lag * step - from * step;
  }
  return { items, master };
}

// ---- Timeline ----------------------------------------------------------------------------------

export interface TimelineClip {
  media: FolderMedia;
  /** In and out points in the file's own time. */
  inSec: number;
  outSec: number;
  /** Position on the timeline. */
  startSec: number;
  label: string;
}

export interface DraftTimeline {
  video: TimelineClip[];
  broll: TimelineClip[];
  audio: TimelineClip[];
  durationSec: number;
}

/** Cameras that cover master time [a, b] completely. */
function camerasCovering(
  items: readonly FolderMedia[],
  a: number,
  b: number,
  roles: FolderMediaRole[],
): FolderMedia[] {
  return items.filter(
    (m) =>
      m.hasVideo &&
      roles.includes(m.role) &&
      m.offsetSec !== null &&
      m.offsetSec <= a + 0.05 &&
      m.offsetSec + m.durationSec >= b - 0.05,
  );
}

const stem = (word: string) =>
  word
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "")
    .replace(/(ing|es|s)$/, "");

/**
 * Lays the story out on a timeline: each talking part on a camera that covers it (alternating
 * when there are several, for variety), songs on a performance camera when one covers them,
 * separate performance recordings as they are; the master's sound under synced parts; B-roll
 * on a track above, where its file name is mentioned or spread through long talking parts.
 */
export function assembleTimeline(
  story: PaperEdit,
  items: readonly FolderMedia[],
  master: FolderMedia,
  words: readonly WordCue[],
  performances: ReadonlyMap<string, FolderMedia>,
): DraftTimeline {
  const video: TimelineClip[] = [];
  const audio: TimelineClip[] = [];
  const talkSpans: Array<{ start: number; end: number; a: number; b: number }> =
    [];
  let cursor = 0;
  let talkIndex = 0;
  for (const part of story.parts) {
    if (part.kind === "performance") {
      const take = part.performanceId
        ? performances.get(part.performanceId)
        : undefined;
      if (!take) continue;
      const length = take.durationSec;
      video.push({
        media: take,
        inSec: 0,
        outSec: length,
        startSec: cursor,
        label: part.title,
      });
      if (take.hasAudio)
        audio.push({
          media: take,
          inSec: 0,
          outSec: length,
          startSec: cursor,
          label: part.title,
        });
      cursor += length;
      continue;
    }
    const a = part.startSec;
    const b = part.endSec;
    const isSong = part.kind === "music";
    const preferred = camerasCovering(
      items,
      a,
      b,
      isSong ? ["performance"] : ["talk"],
    );
    const cameras = preferred.length
      ? preferred
      : camerasCovering(items, a, b, ["talk", "performance", "broll"]);
    const camera = cameras.length
      ? cameras[(isSong ? 0 : talkIndex++) % cameras.length]!
      : master.hasVideo
        ? master
        : null;
    if (camera)
      video.push({
        media: camera,
        inSec: a - camera.offsetSec!,
        outSec: b - camera.offsetSec!,
        startSec: cursor,
        label: part.title,
      });
    // Sound: the master (a recorder is usually the best sound) when it covers the part.
    const sound = master.hasAudio ? master : camera;
    if (sound)
      audio.push({
        media: sound,
        inSec: a - (sound.offsetSec ?? 0),
        outSec: b - (sound.offsetSec ?? 0),
        startSec: cursor,
        label: part.title,
      });
    if (!isSong) talkSpans.push({ start: cursor, end: cursor + (b - a), a, b });
    cursor += b - a;
  }

  // B-roll: files that aren't lined up (no shared sound) and are pictures of the session.
  const pool = items.filter(
    (m) => m.hasVideo && m.role === "broll" && m.offsetSec === null,
  );
  const broll: TimelineClip[] = [];
  const used = new Set<string>();
  const overlaps = (start: number, end: number) =>
    broll.some(
      (c) =>
        start < c.startSec + (c.outSec - c.inSec) + 1 && end > c.startSec - 1,
    );
  const place = (
    media: FolderMedia,
    start: number,
    span: { start: number; end: number },
  ) => {
    const length = Math.min(4, media.durationSec, span.end - start - 0.3);
    if (length < 1.5 || overlaps(start, start + length)) return false;
    const inSec = Math.max(0, media.durationSec / 2 - length / 2);
    broll.push({
      media,
      inSec,
      outSec: inSec + length,
      startSec: start,
      label: media.name,
    });
    used.add(media.path);
    return true;
  };
  // 1. Where a shot's name is said.
  const byStem = new Map<string, FolderMedia>();
  for (const media of pool)
    for (const tag of tagsFromName(media.name))
      if (stem(tag).length >= 3) byStem.set(stem(tag), media);
  for (const span of talkSpans) {
    for (const word of words) {
      if (word.deleted || word.start < span.a || word.end > span.b) continue;
      const media = byStem.get(stem(word.text));
      if (media && !used.has(media.path))
        place(media, span.start + (word.start - span.a) - 0.2, span);
    }
  }
  // 2. The rest, one in the middle of each long talking part.
  const rest = pool.filter((m) => !used.has(m.path));
  for (const span of talkSpans) {
    if (!rest.length) break;
    if (span.end - span.start < 20) continue;
    const media = rest.shift()!;
    if (!place(media, span.start + (span.end - span.start) / 2 - 2, span))
      rest.unshift(media);
  }
  return { video, broll, audio, durationSec: cursor };
}
