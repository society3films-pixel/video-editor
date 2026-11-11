/** Files the editor uses (background music), kept in the app's IndexedDB so edits can be reopened. */
const DB_NAME = "openclipper-editor-assets";
const STORE = "assets";

interface StoredAsset {
  id: string;
  name: string;
  type: string;
  blob: Blob;
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
  const asset: StoredAsset = { id, name: file.name, type: file.type, blob: file, savedAt: Date.now() };
  await withStore("readwrite", (store) => store.put(asset));
  return id;
}

export async function loadEditorAsset(id: string): Promise<File | null> {
  const asset = await withStore<StoredAsset | undefined>("readonly", (store) => store.get(id));
  return asset ? new File([asset.blob], asset.name, { type: asset.type }) : null;
}
