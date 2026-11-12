/** Runs Folder → draft end to end and writes the timeline into a new project's folder. */
import { createClipperProject } from "../../persistence/bootstrap.util";
import { createClipperExportSink } from "../../persistence/export-files.util";
import { extractClipAudioForTranscription } from "../../engine/audio/extract.util";
import { transcriptionService } from "../../../../services/transcription.service";
import { buildWordCuesForTranscription } from "../../engine/transcript/cues.util";
import { loadClipperSettings } from "../../settings/settings-storage.util";
import type { WordCue } from "../../lib/media/transcription-export.util";
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
  type DraftTimeline,
  type FolderMedia,
} from "./folder-draft.util";
import {
  buildFolderDraftSrt,
  buildFolderDraftXml,
} from "./folder-draft-export.util";

export interface FolderDraftResult {
  projectId: string;
  items: FolderMedia[];
  master: FolderMedia;
  story: PaperEdit;
  timeline: DraftTimeline;
  files: string[];
  folder: string;
  ai: string;
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

  onProgress(`Transcribing ${master.name}`, 0.35);
  const masterFile = fileFor(master);
  const audio = await extractClipAudioForTranscription(
    masterFile,
    0,
    master.durationSec,
    {
      projectId: project.id,
      signal: options.signal,
      onProgress: (ratio) =>
        onProgress(`Preparing ${master.name}'s sound`, 0.35 + ratio * 0.05),
    },
  );
  const settings = loadClipperSettings();
  const engine =
    settings.transcription.engine === "groq" ||
    settings.transcription.engine === "openrouter"
      ? "parakeet"
      : settings.transcription.engine;
  const transcription = await transcriptionService.transcribe(
    audio.audioPath,
    `folder-draft:${master.path}`,
    project.id,
    {
      signal: options.signal,
      clipStartSec: 0,
      clipEndSec: master.durationSec,
      engine,
      onProgress: (progress) =>
        onProgress(
          `Transcribing ${master.name}`,
          0.4 + (progress.ratio ?? 0) * 0.35,
        ),
    },
  );
  const words: WordCue[] = buildWordCuesForTranscription(
    transcription,
    master.durationSec,
  );
  if (words.length < 200)
    throw new Error(
      `Only ${words.length} words were found in ${master.name}; there's too little talking for a story.`,
    );

  // Performances recorded on their own (not lined up with the interview).
  const performances = new Map<string, FolderMedia>();
  const extras: PaperEditExtra[] = [];
  for (const item of items) {
    if (item.role !== "performance" || item.offsetSec !== null) continue;
    const id = `P${extras.length + 1}`;
    performances.set(id, item);
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

  onProgress("Laying out the timeline", 0.92);
  const timeline = assembleTimeline(story, items, master, words, performances);
  const camera = timeline.video[0]?.media ?? master;
  const sequence = {
    width: camera.width || 1920,
    height: camera.height || 1080,
    fps: camera.fps || 30,
  };
  const base = `${folderName.replace(/[^\p{L}\p{N} _-]/gu, "")}-draft`;
  const xmlPath = await writeText(
    project.id,
    `${base}.xml`,
    buildFolderDraftXml(`${folderName} draft`, timeline, sequence),
  );
  const srt = buildFolderDraftSrt(story, words);
  if (srt) await writeText(project.id, `${base}.srt`, srt);
  onProgress("Done", 1);
  return {
    projectId: project.id,
    items,
    master,
    story,
    timeline,
    files: [`${base}.xml`, ...(srt ? [`${base}.srt`] : [])],
    folder: xmlPath.replace(/[\\/][^\\/]*$/, ""),
    ai: describeAiChoice(choice),
  };
}
