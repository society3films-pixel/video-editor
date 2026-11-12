/** Runs Folder → draft end to end, and re-exports or renders a draft after changes in the app. */
import { createClipperProject } from "../../persistence/bootstrap.util";
import { createClipperExportSink } from "../../persistence/export-files.util";
import { extractClipAudioForTranscription } from "../../engine/audio/extract.util";
import { transcriptionService } from "../../../../services/transcription.service";
import { buildWordCuesForTranscription } from "../../engine/transcript/cues.util";
import { loadClipperSettings } from "../../settings/settings-storage.util";
import type { WordCue } from "../../lib/media/transcription-export.util";
import {
  localRecordGet,
  localRecordPut,
} from "../../../../shared/persistence/local-database.util";
import { resolveAiChoice, describeAiChoice } from "../ai-editor/ai-choice.util";
import {
  buildPaperEdit,
  type PaperEdit,
  type PaperEditExtra,
} from "../ai-editor/ai-paper-edit.util";
import {
  analyzeShoot,
  assembleTimeline,
  fileFor,
  mergeWords,
  type AssembleOptions,
  type CameraActivity,
  type DraftTimeline,
  type FolderMedia,
} from "./folder-draft.util";
import {
  buildFolderDraftSrt,
  buildFolderDraftXml,
  draftCaptions,
} from "./folder-draft-export.util";
import { renderDraftTimeline } from "./folder-draft-render.util";

/** Everything needed to change, re-export or render a draft later (kept per project). */
export interface FolderDraft {
  projectId: string;
  name: string;
  /** File name base for what's written ("<folder>-draft"). */
  base: string;
  items: FolderMedia[];
  masterPath: string;
  /** On the master's clock, from every recorder (or the master). */
  words: WordCue[];
  story: PaperEdit;
  /** Separately recorded performances by id (P1…) → file path. */
  performances: Record<string, string>;
  cameraFor: Record<number, string>;
  noBroll: boolean;
  /** Mouth movement per camera, once analysed: the draft cuts to whoever is talking. */
  activity?: CameraActivity;
  ai: string;
  createdAt: number;
}

export interface FolderDraftResult {
  draft: FolderDraft;
  timeline: DraftTimeline;
  files: string[];
  folder: string;
}

const NAMESPACE = "clipper-folder-drafts";
const LAST_KEY = "last";

export async function saveFolderDraft(draft: FolderDraft): Promise<void> {
  await localRecordPut(NAMESPACE, draft.projectId, draft.projectId, draft);
  await localRecordPut(NAMESPACE, LAST_KEY, null, draft.projectId);
}

export async function loadLastFolderDraft(): Promise<FolderDraft | null> {
  const id = await localRecordGet<string>(NAMESPACE, LAST_KEY).catch(
    () => null,
  );
  return id
    ? ((await localRecordGet<FolderDraft>(NAMESPACE, id).catch(() => null)) ??
        null)
    : null;
}

export function draftMaster(draft: FolderDraft): FolderMedia {
  return (
    draft.items.find((m) => m.path === draft.masterPath) ?? draft.items[0]!
  );
}

export function draftTimeline(draft: FolderDraft): DraftTimeline {
  const performances = new Map<string, FolderMedia>();
  for (const [id, path] of Object.entries(draft.performances)) {
    const media = draft.items.find((m) => m.path === path);
    if (media) performances.set(id, media);
  }
  const options: AssembleOptions = {
    cameraFor: new Map(
      Object.entries(draft.cameraFor).map(([k, v]) => [Number(k), v]),
    ),
    noBroll: draft.noBroll,
    activity: draft.activity,
  };
  return assembleTimeline(
    draft.story,
    draft.items,
    draftMaster(draft),
    draft.words,
    performances,
    options,
  );
}

/** The draft's picture size and frame rate: the first camera's. */
export function draftSequence(timeline: DraftTimeline, fallback: FolderMedia) {
  const camera = timeline.video[0]?.media ?? fallback;
  return {
    width: camera.width || 1920,
    height: camera.height || 1080,
    fps: camera.fps || 30,
  };
}

async function writeText(
  projectId: string,
  name: string,
  text: string,
): Promise<string> {
  const sink = await createClipperExportSink(projectId, name);
  if (!sink) throw new Error("Couldn't write to the project folder.");
  try {
    const writer = sink.writable.getWriter();
    await writer.write({
      type: "write",
      data: new TextEncoder().encode(text),
      position: 0,
    });
    await writer.close();
    const disk = await sink.finalize();
    return disk.filePath || disk.displayPath || name;
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}

const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** Writes the Premiere / Resolve timeline and the .srt for the draft as it is now. */
export async function exportFolderDraft(
  draft: FolderDraft,
): Promise<FolderDraftResult> {
  await saveFolderDraft(draft);
  const timeline = draftTimeline(draft);
  const xmlPath = await writeText(
    draft.projectId,
    `${draft.base}.xml`,
    buildFolderDraftXml(
      draft.name,
      timeline,
      draftSequence(timeline, draftMaster(draft)),
    ),
  );
  const srt = buildFolderDraftSrt(draft.story, draft.words);
  if (srt) await writeText(draft.projectId, `${draft.base}.srt`, srt);
  return {
    draft,
    timeline,
    files: [`${draft.base}.xml`, ...(srt ? [`${draft.base}.srt`] : [])],
    folder: folderOf(xmlPath),
  };
}

/** Renders the draft to an MP4 in the project folder. Returns its path. */
export async function renderFolderDraft(
  draft: FolderDraft,
  options: {
    captions: boolean;
    maxHeight?: number;
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const timeline = draftTimeline(draft);
  const name = `${draft.base}.mp4`;
  const sink = await createClipperExportSink(draft.projectId, name);
  if (!sink) throw new Error("Couldn't write to the project folder.");
  try {
    await renderDraftTimeline(timeline, {
      ...draftSequence(timeline, draftMaster(draft)),
      maxHeight: options.maxHeight,
      captions: options.captions
        ? draftCaptions(draft.story, draft.words)
        : undefined,
      outputSink: sink.writable,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const disk = await sink.finalize();
    return disk.filePath || disk.displayPath || name;
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}

export async function runFolderDraft(
  dir: string,
  options: {
    targetMinutes: number;
    focus: string;
    token: string;
    onProgress: (step: string, ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<FolderDraftResult> {
  const { onProgress } = options;
  const folderName = dir.split(/[\\/]/).filter(Boolean).pop() ?? "Shoot";
  const choice = await resolveAiChoice();

  onProgress("Sorting and lining up the files", 0);
  const { items, master } = await analyzeShoot(dir, (step, ratio) =>
    onProgress(step, ratio * 0.35),
  );
  if (!master)
    throw new Error("None of the files has sound to line the others up to.");

  const project = await createClipperProject({
    name: `${folderName} draft`,
    token: options.token,
  });

  // What's said: every lined-up recorder (a recorder may split a long take into several files),
  // or the master camera when there's no recorder.
  const recorders = items.filter(
    (m) => m.role === "recorder" && m.offsetSec !== null,
  );
  const sources = recorders.length
    ? [
        master,
        ...recorders
          .filter((m) => m !== master)
          .sort((a, b) => a.offsetSec! - b.offsetSec!),
      ]
    : [master];
  const settings = loadClipperSettings();
  const engine =
    settings.transcription.engine === "groq" ||
    settings.transcription.engine === "openrouter"
      ? "parakeet"
      : settings.transcription.engine;
  const transcripts: Array<{ offsetSec: number; words: WordCue[] }> = [];
  for (const [index, source] of sources.entries()) {
    const base = 0.35 + (index / sources.length) * 0.4;
    const share = 0.4 / sources.length;
    onProgress(`Transcribing ${source.name}`, base);
    const audio = await extractClipAudioForTranscription(
      fileFor(source),
      0,
      source.durationSec,
      {
        projectId: project.id,
        signal: options.signal,
        onProgress: (ratio) =>
          onProgress(
            `Preparing ${source.name}'s sound`,
            base + ratio * share * 0.15,
          ),
      },
    );
    const transcription = await transcriptionService.transcribe(
      audio.audioPath,
      `folder-draft:${source.path}`,
      project.id,
      {
        signal: options.signal,
        clipStartSec: 0,
        clipEndSec: source.durationSec,
        engine,
        onProgress: (progress) =>
          onProgress(
            `Transcribing ${source.name}`,
            base + share * (0.15 + (progress.ratio ?? 0) * 0.85),
          ),
      },
    );
    transcripts.push({
      offsetSec: source.offsetSec ?? 0,
      words: buildWordCuesForTranscription(transcription, source.durationSec),
    });
  }
  const words = mergeWords(transcripts);
  if (words.length < 200)
    throw new Error(
      `Only ${words.length} words were found; there's too little talking for a story.`,
    );

  // Performances recorded on their own (not lined up with the interview).
  const performances: Record<string, string> = {};
  const extras: PaperEditExtra[] = [];
  for (const item of items) {
    if (item.role !== "performance" || item.offsetSec !== null) continue;
    const id = `P${extras.length + 1}`;
    performances[id] = item.path;
    extras.push({
      id,
      label: item.name.replace(/\.[^.]+$/, ""),
      durationSec: item.durationSec,
    });
  }

  onProgress(`Building the story with ${describeAiChoice(choice)}`, 0.78);
  const story = await buildPaperEdit(
    choice,
    words,
    options.targetMinutes,
    options.focus,
    extras,
  );

  onProgress("Writing the timeline", 0.95);
  const result = await exportFolderDraft({
    projectId: project.id,
    name: `${folderName} draft`,
    base: `${folderName.replace(/[^\p{L}\p{N} _-]/gu, "")}-draft`,
    items,
    masterPath: master.path,
    words,
    story,
    performances,
    cameraFor: {},
    noBroll: false,
    ai: describeAiChoice(choice),
    createdAt: Date.now(),
  });
  onProgress("Done", 1);
  return result;
}
