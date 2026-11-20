/**
 * Picks media files. In the desktop app the system dialog returns paths, so files are used in
 * place (no upload into the webview); in the browser a file input is used.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../../../shared/utils/platform.util";
import { pathBackedFile } from "../platform/native-source.util";

export type MediaKind = "video" | "audio" | "image" | "visual";

const EXTENSIONS: Record<MediaKind, string[]> = {
  video: ["mp4", "mov", "m4v", "mkv", "webm"],
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"],
  image: ["png", "jpg", "jpeg", "webp"],
  visual: ["mp4", "mov", "m4v", "webm", "png", "jpg", "jpeg", "webp"],
};

const ACCEPT: Record<MediaKind, string> = {
  video: "video/*",
  audio: "audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.opus",
  image: "image/*",
  visual: "image/*,video/*",
};

function mimeFor(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
  if (["mp3"].includes(ext)) return "audio/mpeg";
  if (["m4a", "aac"].includes(ext)) return "audio/mp4";
  if (["wav", "ogg", "flac", "opus"].includes(ext)) return `audio/${ext}`;
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return "video/mp4";
}

export async function pickMediaFiles(kind: MediaKind, multiple = false): Promise<File[]> {
  if (isTauri()) {
    const picked = await open({ multiple, filters: [{ name: kind, extensions: EXTENSIONS[kind] }] });
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    return paths.map((path) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      return pathBackedFile(path, name, mimeFor(name));
    });
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT[kind];
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
