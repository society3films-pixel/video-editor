import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});
const store = new Map<string, unknown>();
vi.mock("../../../shared/persistence/local-database.util", () => ({
  localRecordGet: vi.fn(async (_ns: string, key: string) => store.get(key) ?? null),
  localRecordPut: vi.fn(async (_ns: string, key: string, _p: string, value: unknown) => void store.set(key, value)),
  localRecordDelete: vi.fn(async (_ns: string, key: string) => void store.delete(key)),
}));
import { deleteDraft, draftKey, loadDraft, saveDraft } from "./editor-drafts.util";
import { createInitialClipEdit } from "./clip-edit.util";

describe("editor autosave", () => {
  it("keys drafts by export, or by clip in framing mode", () => {
    expect(draftKey("p", "e1", undefined)).toBe("p:export:e1");
    expect(draftKey("p", undefined, [{ startSec: 1, endSec: 2.5 }] as never)).toBe("p:clip:1.00-2.50");
  });
  it("saves, loads and removes a draft", async () => {
    const edit = { ...createInitialClipEdit(10), volume: 0.5 };
    await saveDraft("k", "p", edit);
    const draft = await loadDraft("k");
    expect(draft?.edit.volume).toBe(0.5);
    await deleteDraft("k");
    expect(await loadDraft("k")).toBeNull();
  });
});
