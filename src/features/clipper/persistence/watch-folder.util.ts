/**
 * Watch folder: new videos dropped into a folder become projects that are transcribed, clipped
 * and rendered with no clicks, one at a time, while the app is open on its home page.
 */
import { invoke } from "@tauri-apps/api/core";

export interface WatchFolderSettings {
  dir: string | null;
  enabled: boolean;
  /** Start rendering every clip once the clips are ready. */
  autoRender: boolean;
}

export interface WatchedVideoFile {
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
}

/** The project being processed for the watch folder (read by the session page's automation). */
export interface WatchFolderJob {
  projectId: string;
  path: string;
  name: string;
  autoRender: boolean;
  startedAt: number;
}

export interface WatchFolderLogEntry {
  name: string;
  projectId: string | null;
  status: "processing" | "done" | "failed";
  at: number;
  detail?: string;
}

const SETTINGS_KEY = "openclipper.watchFolder";
const PROCESSED_KEY = "openclipper.watchFolder.processed";
const JOB_KEY = "openclipper.watchFolder.job";
const LOG_KEY = "openclipper.watchFolder.log";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable.
  }
}

export const loadWatchFolderSettings = (): WatchFolderSettings => ({ dir: null, enabled: false, autoRender: true, ...read<Partial<WatchFolderSettings>>(SETTINGS_KEY, {}) });
export const saveWatchFolderSettings = (settings: WatchFolderSettings) => write(SETTINGS_KEY, settings);

export const fileKey = (file: Pick<WatchedVideoFile, "path" | "size">) => `${file.path}|${file.size}`;
export const loadProcessed = (): string[] => read<string[]>(PROCESSED_KEY, []);
export function markProcessed(file: Pick<WatchedVideoFile, "path" | "size">): void {
  write(PROCESSED_KEY, [...loadProcessed(), fileKey(file)].slice(-2000));
}
/** Treat every video already in the folder as done (when the folder is first chosen). */
export function markAllProcessed(files: readonly WatchedVideoFile[]): void {
  write(PROCESSED_KEY, [...new Set([...loadProcessed(), ...files.map(fileKey)])].slice(-2000));
}

export const loadJob = (): WatchFolderJob | null => read<WatchFolderJob | null>(JOB_KEY, null);
export const saveJob = (job: WatchFolderJob | null) => write(JOB_KEY, job);

export const loadLog = (): WatchFolderLogEntry[] => read<WatchFolderLogEntry[]>(LOG_KEY, []);
export function logEntry(entry: WatchFolderLogEntry): void {
  const log = loadLog().filter((item) => !(item.projectId && item.projectId === entry.projectId));
  write(LOG_KEY, [entry, ...log].slice(0, 30));
}

export function listWatchFolderVideos(dir: string): Promise<WatchedVideoFile[]> {
  return invoke<WatchedVideoFile[]>("list_watch_folder_videos", { dir });
}

/**
 * New files ready to process: not done before, and finished copying (same size as on the last
 * poll and untouched for 15 s).
 */
export function readyFiles(
  files: readonly WatchedVideoFile[],
  previousSizes: ReadonlyMap<string, number>,
  processed: ReadonlySet<string>,
  now = Date.now(),
): WatchedVideoFile[] {
  return files.filter(
    (file) => !processed.has(fileKey(file)) && file.size > 0 && previousSizes.get(file.path) === file.size && now - file.modifiedMs > 15_000,
  );
}

export function videoMimeType(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === "mov" ? "video/quicktime" : ext === "webm" ? "video/webm" : ext === "mkv" ? "video/x-matroska" : "video/mp4";
}
