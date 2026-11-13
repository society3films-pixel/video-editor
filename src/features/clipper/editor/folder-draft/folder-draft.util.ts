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
import {
  fileTimeOf,
  masterTimeOf,
  readTimecode,
  refineOffset,
  syncFeature,
  syncItem,
} from "./folder-draft-sync.util";
import { tagsFromName } from "../broll-library.util";
import type { PaperEdit } from "../ai-editor/ai-paper-edit.util";

export type FolderMediaRole = "talk" | "performance" | "broll" | "recorder";

export interface FolderMedia {
  path: string;
  name: string;
  /** Subfolder in the shoot folder (absent in drafts made before subfolders were searched). */
  folder?: string;
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
  /** Clock drift against the master (master time = offset + file time × (1 + drift)). */
  drift?: number;
  syncScore: number;
  /** How the file was lined up, and how many of the places checked agreed. */
  sync?: {
    method: "sound" | "timecode" | "manual";
    agreed: number;
    tried: number;
    refined: boolean;
  };
  /** Which camera recorded it ("Cam A"): stop-start clips of one camera share a group. */
  group?: string;
  /** Embedded timecode of the file's start (seconds since midnight), when it has one. */
  timecodeSec?: number | null;
}

interface ListedFile {
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
  /** Subfolder inside the shoot folder ("" when directly in it). */
  folder: string;
}

/**
 * What a folder name says its files are ("Audio", "Sound/Zoom", "B-roll", "Cam A", "Performance",
 * "Live songs"…), checked from the innermost folder out. Null when it doesn't say.
 */
export function roleFromFolder(folder: string): FolderMediaRole | null {
  for (const part of folder.split("/").reverse()) {
    const name = part.toLowerCase();
    if (
      /b[\s_-]*roll|cutaway|insert|detail|establishing|\bbts\b|behind/.test(
        name,
      )
    )
      return "broll";
    if (/interview/.test(name)) return "talk";
    if (/perform|live|song|music|set\b|gig|concert|session|playing/.test(name))
      return "performance";
    if (
      /audio|sound|recorder|\bzoom\b|tascam|\bwav\b|\blav|\bmic|\bboom/.test(
        name,
      )
    )
      return "recorder";
    if (
      /interview|\bcam|camera|\ba[\s_-]?cam|\bb[\s_-]?cam|angle|\bwide|\bclose|talk/.test(
        name,
      )
    )
      return "talk";
  }
  return null;
}

/** A folder's hint wins over the sound when it fits the file (a recorder has no picture, etc.). */
export function classifyWithFolder(
  item: {
    hasVideo: boolean;
    hasAudio: boolean;
    durationSec: number;
    speech: number;
    music: number;
  },
  folder: string,
): FolderMediaRole {
  const hint = roleFromFolder(folder);
  if (hint === "recorder" && !item.hasVideo && item.hasAudio) return "recorder";
  if (hint === "broll" && item.hasVideo) return "broll";
  if (
    (hint === "performance" || hint === "talk") &&
    item.hasVideo &&
    item.hasAudio
  )
    return hint;
  return classifyMedia(item);
}

const AUDIO_ONLY = /\.(wav|mp3|m4a|aac|flac|aiff?|ogg)$/i;
const SILENCE_RMS = 0.004;

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
    const folder = file.folder ?? "";
    const shown = folder ? `${folder}/${file.name}` : file.name;
    onProgress(`Listening to ${shown}`, index / listed.length);
    const info = await probe(file.path, file.name).catch(() => null);
    if (!info) continue;
    let profile = { speech: 0, music: 0, silent: 1 };
    if (info.hasAudio) {
      const levels = await frameLevels(
        fileFor({ path: file.path, name: file.name }),
      );
      profile = soundProfile(levels);
      // B-roll (by its folder) isn't lined up: it's placed as cutaways.
      if (roleFromFolder(folder) !== "broll" || !info.hasVideo)
        envelopes.set(file.path, syncFeature(levels));
    }
    const base = { ...info, speech: profile.speech, music: profile.music };
    items.push({
      path: file.path,
      name: file.name,
      folder,
      ...base,
      role: classifyWithFolder(base, folder),
      offsetSec: null,
      syncScore: 0,
      timecodeSec: await readTimecode(file.path),
    });
  }
  const master = chooseMaster(items);
  if (!master) return { items, master: null };
  master.offsetSec = 0;
  master.syncScore = 1;
  master.drift = 0;
  master.sync = { method: "sound", agreed: 1, tried: 1, refined: false };
  // Each file is lined up against everything already lined up: first the master, then any other
  // synced file. That way a recorder that split a long take into several files still lines up
  // through a camera that ran across the split, and a second camera through the first.
  const priority = (m: FolderMedia) =>
    m.role === "recorder" ? 0 : m.role === "talk" ? 1 : 2;
  const pending = items
    .filter((m) => m !== master && envelopes.has(m.path))
    .sort((a, b) => priority(a) - priority(b));
  const synced: FolderMedia[] = [master];
  const total = pending.length;
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (const item of [...pending]) {
      onProgress(
        `Lining up ${item.name}`,
        (total - pending.length) / Math.max(1, total),
      );
      // Timecode guess from any lined-up file that has timecode too (same day).
      let prior: number | null = null;
      if (item.timecodeSec != null) {
        const withTc = synced.find(
          (m) =>
            m.timecodeSec != null &&
            Math.abs(item.timecodeSec! - m.timecodeSec!) < 12 * 3600,
        );
        if (withTc)
          prior = masterTimeOf(withTc, item.timecodeSec - withTc.timecodeSec!);
      }
      const result = syncItem(
        envelopes.get(item.path)!,
        synced.map((media) => ({ media, feature: envelopes.get(media.path)! })),
        prior,
      );
      if (!result) continue;
      item.offsetSec = result.offsetSec;
      item.drift = result.drift;
      item.syncScore = result.score;
      item.sync = {
        method: result.method,
        agreed: result.agreed,
        tried: result.tried,
        refined: false,
      };
      synced.push(item);
      pending.splice(pending.indexOf(item), 1);
      progressed = true;
    }
  }
  // Sub-frame accuracy: refine each on fine sound detail against the master (or what overlaps).
  for (const [index, item] of synced.entries()) {
    if (item === master || item.sync?.method !== "sound") continue;
    onProgress(`Fine-tuning ${item.name}`, index / synced.length);
    for (const reference of [
      master,
      ...synced.filter((m) => m !== item && m !== master),
    ]) {
      const refined = await refineOffset(item, reference).catch(() => null);
      if (refined) {
        item.offsetSec = refined.offsetSec;
        item.sync = { ...item.sync, refined: true };
        break;
      }
    }
  }
  assignCameraGroups(items);
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
  /** Each camera's own sound under its picture (muted in the timeline; for checking sync). */
  scratch: TimelineClip[];
  /** Where each story part starts on the timeline. */
  markers: Array<{ startSec: number; title: string }>;
  /** One track per camera: its footage under every lined-up part (for switching cameras in the editor). */
  angles: Array<{ label: string; clips: TimelineClip[] }>;
  durationSec: number;
}

export interface AssembleOptions {
  /** Camera picked by hand per story part (part index → file path). */
  cameraFor?: ReadonlyMap<number, string>;
  /** No B-roll track. */
  noBroll?: boolean;
  /** Mouth movement per camera (see folder-draft-speaker.util): cut to whoever is talking. */
  activity?: CameraActivity;
}

/** Mouth movement of each camera's main face, on the master's clock, in 0.5 s bins. */
export type CameraActivity = Record<
  string,
  Array<{ start: number; step: number; values: number[] }>
>;

interface Shot {
  camera: FolderMedia;
  a: number;
  b: number;
}

/** A camera stays at least this long, and changes after this long when nobody else is talking. */
const MIN_SHOT_SEC = 2.5;
const VARIETY_SEC = 14;

function activityIn(
  runs: CameraActivity[string] | undefined,
  a: number,
  b: number,
): number | null {
  let sum = 0;
  let count = 0;
  for (const run of runs ?? []) {
    for (
      let k = Math.max(0, Math.floor((a - run.start) / run.step));
      k < run.values.length;
      k++
    ) {
      const t = run.start + k * run.step;
      if (t >= b) break;
      sum += run.values[k]!;
      count++;
    }
  }
  return count ? sum / count : null;
}

/** A camera's resting mouth movement (its person listening): the 20th percentile. */
function restingLevel(values: number[]): number {
  const sorted = values.filter((v) => v > 0).sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length * 0.2)]! : 0;
}

/**
 * Splits a talking part into camera shots at sentence ends and pauses. With mouth movement per
 * camera, each sentence goes to the camera whose person is talking (compared with that person's
 * mouth at rest); otherwise, and when it's unclear (two angles on the same person),
 * the camera changes every so often for variety.
 */
export function planShots(
  a: number,
  b: number,
  cameras: readonly FolderMedia[],
  words: readonly WordCue[],
  activity: CameraActivity | undefined,
  rotation: number,
): Shot[] {
  if (cameras.length < 2) return [{ camera: cameras[0]!, a, b }];
  const inside = words.filter((w) => !w.deleted && w.start >= a && w.end <= b);
  const cuts: number[] = [];
  for (let i = 0; i < inside.length - 1; i++) {
    const w = inside[i]!;
    const next = inside[i + 1]!;
    if (!/[.?!]["”']?$/.test(w.text) && next.start - w.end < 0.6) continue;
    const t = (w.end + next.start) / 2;
    if (t - a >= MIN_SHOT_SEC && b - t >= MIN_SHOT_SEC) cuts.push(t);
  }
  const bounds = [a, ...cuts, b];
  const usual = new Map(
    cameras.map((c) => [
      c.path,
      restingLevel((activity?.[c.path] ?? []).flatMap((r) => r.values)),
    ]),
  );
  const speakerFor = (s: number, e: number): FolderMedia | null => {
    if (!activity) return null;
    const scored = cameras
      .map((camera) => {
        const value = activityIn(activity[camera.path], s, e);
        const base = usual.get(camera.path) || 0;
        return { camera, score: value !== null && base > 0 ? value / base : 0 };
      })
      .sort((x, y) => y.score - x.score);
    return scored[0]!.score > 0 &&
      scored[0]!.score >= (scored[1]?.score ?? 0) * 1.25
      ? scored[0]!.camera
      : null;
  };
  const shots: Shot[] = [];
  let current = cameras[rotation % cameras.length]!;
  let shotStart = a;
  let turn = rotation;
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = bounds[i]!;
    const e = bounds[i + 1]!;
    const speaker = speakerFor(s, e);
    let want = speaker ?? current;
    if (!speaker && s - shotStart >= VARIETY_SEC)
      want = cameras[++turn % cameras.length]!;
    if (want !== current && s - shotStart >= MIN_SHOT_SEC) {
      shots.push({ camera: current, a: shotStart, b: s });
      current = want;
      shotStart = s;
    } else if (want !== current && !shots.length && s === a) {
      current = want;
    }
  }
  shots.push({ camera: current, a: shotStart, b });
  return shots;
}

/** Keeps only words fromIdx..toIdx of a talking part. */
export function trimStoryPart(
  story: PaperEdit,
  index: number,
  fromIdx: number,
  toIdx: number,
  words: readonly WordCue[],
): PaperEdit {
  const part = story.parts[index];
  if (
    !part ||
    part.kind !== "talk" ||
    toIdx < fromIdx ||
    !words[fromIdx] ||
    !words[toIdx]
  )
    return story;
  const parts = [...story.parts];
  parts[index] = {
    ...part,
    wordStartIdx: fromIdx,
    wordEndIdx: toIdx,
    startSec: words[fromIdx]!.start,
    endSec: words[toIdx]!.end,
  };
  return { ...story, parts };
}

/** Removes words fromIdx..toIdx from a talking part (it may become two parts, or none). Returns how many parts replace it. */
export function cutStoryPart(
  story: PaperEdit,
  index: number,
  fromIdx: number,
  toIdx: number,
  words: readonly WordCue[],
): { story: PaperEdit; replacedBy: number } {
  const part = story.parts[index];
  if (!part || part.kind !== "talk") return { story, replacedBy: 1 };
  const pieces = [];
  if (fromIdx > part.wordStartIdx)
    pieces.push({
      ...part,
      wordEndIdx: fromIdx - 1,
      endSec: words[fromIdx - 1]!.end,
    });
  if (toIdx < part.wordEndIdx)
    pieces.push({
      ...part,
      title: pieces.length ? `${part.title} (cont.)` : part.title,
      wordStartIdx: toIdx + 1,
      startSec: words[toIdx + 1]!.start,
    });
  const parts = [...story.parts];
  parts.splice(index, 1, ...pieces);
  return { story: { ...story, parts }, replacedBy: pieces.length };
}

/** Synced files with sound that cover master time [a, b]: recorders first, then the given camera. */
function soundFor(
  items: readonly FolderMedia[],
  master: FolderMedia,
  camera: FolderMedia | null,
  a: number,
  b: number,
): FolderMedia | null {
  const covers = (m: FolderMedia) =>
    m.hasAudio &&
    m.offsetSec !== null &&
    m.offsetSec <= a + 0.05 &&
    masterTimeOf(m, m.durationSec) >= b - 0.05;
  const recorders = items.filter((m) => m.role === "recorder" && covers(m));
  if (covers(master) && (master.role === "recorder" || !recorders.length))
    return master;
  if (recorders.length) return recorders[0]!;
  if (camera && covers(camera)) return camera;
  return items.find((m) => m.hasVideo && covers(m)) ?? null;
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
      masterTimeOf(m, m.durationSec) >= b - 0.05,
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
  options: AssembleOptions = {},
): DraftTimeline {
  const video: TimelineClip[] = [];
  const audio: TimelineClip[] = [];
  const scratch: TimelineClip[] = [];
  const markers: DraftTimeline["markers"] = [];
  const angleClips = new Map<string, TimelineClip[]>();
  const talkSpans: Array<{ start: number; end: number; a: number; b: number }> =
    [];
  let cursor = 0;
  let talkIndex = 0;
  for (const [partIndex, part] of story.parts.entries()) {
    markers.push({ startSec: cursor, title: part.title });
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
    const picked = options.cameraFor?.get(partIndex);
    const pickedCamera = picked
      ? camerasCovering(items, a, b, ["talk", "performance", "broll"]).find(
          (m) => m.path === picked,
        )
      : undefined;
    let shots: Shot[];
    if (pickedCamera) shots = [{ camera: pickedCamera, a, b }];
    else if (!cameras.length)
      shots = master.hasVideo ? [{ camera: master, a, b }] : [];
    else if (isSong) shots = [{ camera: cameras[0]!, a, b }];
    else {
      shots = planShots(a, b, cameras, words, options.activity, talkIndex);
      talkIndex += shots.length;
    }
    for (const shot of shots) {
      video.push({
        media: shot.camera,
        inSec: fileTimeOf(shot.camera, shot.a),
        outSec: fileTimeOf(shot.camera, shot.b),
        startSec: cursor + shot.a - a,
        label: part.title,
      });
    }
    // Sound: a separate recorder when one covers the part, else the camera's own.
    const sound = soundFor(items, master, shots[0]?.camera ?? null, a, b);
    if (sound)
      audio.push({
        media: sound,
        inSec: fileTimeOf(sound, a),
        outSec: fileTimeOf(sound, b),
        startSec: cursor,
        label: part.title,
      });
    for (const shot of shots) {
      if (!shot.camera.hasAudio || shot.camera === sound) continue;
      scratch.push({
        media: shot.camera,
        inSec: fileTimeOf(shot.camera, shot.a),
        outSec: fileTimeOf(shot.camera, shot.b),
        startSec: cursor + shot.a - a,
        label: part.title,
      });
    }
    if (!isSong) talkSpans.push({ start: cursor, end: cursor + (b - a), a, b });
    // Every camera's view of this part, on its camera's track.
    for (const media of camerasCovering(items, a, b, [
      "talk",
      "performance",
      "broll",
    ])) {
      const label = media.group ?? media.name;
      const list = angleClips.get(label) ?? [];
      if (!list.some((c) => c.startSec === cursor)) {
        list.push({
          media,
          inSec: fileTimeOf(media, a),
          outSec: fileTimeOf(media, b),
          startSec: cursor,
          label: `${label}: ${part.title}`,
        });
      }
      angleClips.set(label, list);
    }
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
    for (const tag of tagsFromName(`${media.folder ?? ""} ${media.name}`))
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
  const angles = [...angleClips.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([label, clips]) => ({ label, clips }));
  return { video, broll, audio, scratch, markers, angles, durationSec: cursor };
}

/** Cameras that could show a story part (for picking one by hand). */
export function camerasForPart(
  items: readonly FolderMedia[],
  part: PaperEdit["parts"][number],
): FolderMedia[] {
  if (part.kind === "performance") return [];
  return camerasCovering(items, part.startSec, part.endSec, [
    "talk",
    "performance",
    "broll",
  ]);
}

/** Merges transcripts of several recordings (on the master's clock), skipping overlaps. */
export function mergeWords(
  parts: ReadonlyArray<{ offsetSec: number; words: readonly WordCue[] }>,
): WordCue[] {
  const merged: WordCue[] = [];
  const covered: Array<[number, number]> = [];
  for (const part of parts) {
    if (!part.words.length) continue;
    const shifted = part.words.map((w) => ({
      ...w,
      start: w.start + part.offsetSec,
      end: w.end + part.offsetSec,
    }));
    const overlaps = (t: number) => covered.some(([a, b]) => t >= a && t < b);
    merged.push(...shifted.filter((w) => !overlaps(w.start)));
    covered.push([shifted[0]!.start, shifted[shifted.length - 1]!.end]);
  }
  return merged.sort((a, b) => a.start - b.start);
}

/**
 * Groups a shoot's camera files by camera: files in the same subfolder, or with the same name
 * pattern (A001C002…, C0001…, GX01…), are one camera's stop-start clips. Labels come from the
 * folder name when there is one ("Cam A"), else "Cam A", "Cam B"… in order.
 */
export function assignCameraGroups(items: FolderMedia[]): void {
  const cameras = items.filter((m) => m.hasVideo && m.role !== "broll");
  const keyOf = (m: FolderMedia) => {
    const folder = (m.folder ?? "").split("/").filter(Boolean).pop();
    if (
      folder &&
      !/^(video|videos|footage|media|clips?|dcim|private|m4root|clip|100\w*)$/i.test(
        folder,
      )
    )
      return `folder:${m.folder}`;
    const stem = m.name.replace(/\.[^.]+$/, "");
    const prefix = stem.match(/^[A-Za-z_-]*/)![0] || "camera";
    return `${m.folder ?? ""}/${prefix.toLowerCase()}`;
  };
  const keys = [...new Set(cameras.map(keyOf))].sort();
  const letter = (i: number) =>
    String.fromCharCode(65 + (i % 26)) +
    (i >= 26 ? String(Math.floor(i / 26)) : "");
  const labels = new Map<string, string>();
  keys.forEach((key, i) => {
    const folder = key.startsWith("folder:")
      ? key.slice(7).split("/").filter(Boolean).pop()
      : null;
    labels.set(key, folder && keys.length > 1 ? folder : `Cam ${letter(i)}`);
  });
  for (const m of cameras) m.group = labels.get(keyOf(m));
}
