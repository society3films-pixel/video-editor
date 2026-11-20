/**
 * Files the editor uses (music, B-roll, camera angles). In the desktop app a file picked from disk
 * is kept as a reference to its path (no copy: big camera files stay where they are, and native
 * analysis can read them); otherwise the file itself is kept in the app's IndexedDB.
 */
import { getNativeFilePath, pathBackedFile } from "../platform/native-source.util";
import { resolveFilePlayableUrl } from "../persistence/tauri-media.util";
const DB_NAME = "openclipper-editor-assets";
const STORE = "assets";

interface StoredAsset {
  id: string;
  name: string;
  type: string;
  /** The file's bytes (web, or files without a path). */
  blob?: Blob;
  /** Path on disk (desktop picker). */
  path?: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Couldn't open the editor's file store."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("The editor's file store failed."));
    });
  } finally {
    db.close();
  }
}

export async function saveEditorAsset(file: File): Promise<string> {
  const id = `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const path = getNativeFilePath(file);
  const asset: StoredAsset = path
    ? { id, name: file.name, type: file.type, path, savedAt: Date.now() }
    : { id, name: file.name, type: file.type, blob: file, savedAt: Date.now() };
  await withStore("readwrite", (store) => store.put(asset));
  return id;
}

export async function loadEditorAsset(id: string): Promise<File | null> {
  const asset = await withStore<StoredAsset | undefined>("readonly", (store) => store.get(id));
  if (!asset) return null;
  if (asset.path) return pathBackedFile(asset.path, asset.name, asset.type || "application/octet-stream");
  return asset.blob ? new File([asset.blob], asset.name, { type: asset.type }) : null;
}

/** A URL a <video>/<audio> element can play, for both kinds of asset. */
export function playableUrl(file: File): Promise<string> {
  return resolveFilePlayableUrl(file);
}

/** The bytes of an asset (images from disk need reading; createImageBitmap can't take a path). */
export async function assetBlob(file: File): Promise<Blob> {
  if (!getNativeFilePath(file)) return file;
  const response = await fetch(await resolveFilePlayableUrl(file));
  if (!response.ok) throw new Error(`Couldn't read "${file.name}" from disk.`);
  return new Blob([await response.arrayBuffer()], { type: file.type });
}
