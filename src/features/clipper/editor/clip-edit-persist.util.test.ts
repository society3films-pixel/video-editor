import { describe, expect, it } from "vitest";
import { createInitialClipEdit, splitClipEditAt } from "./clip-edit.util";
import { fromPersistedClipEdit, toPersistedClipEdit } from "./clip-edit-persist.util";

describe("saved clip edits", () => {
  it("round-trips without framing and clamps to the clip duration", () => {
    const edit = {
      ...splitClipEditAt(createInitialClipEdit(10), 4),
      volume: 0.5,
      framing: { keyframes: [], extraShotBoundaries: [3] },
    };
    const saved = JSON.parse(JSON.stringify(toPersistedClipEdit(edit)));
    expect(saved.framing).toBeUndefined();
    const restored = fromPersistedClipEdit(saved, 8);
    expect(restored?.segments.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 8]]);
    expect(restored?.volume).toBe(0.5);
  });

  it("rejects unusable data", () => {
    expect(fromPersistedClipEdit(null, 10)).toBeNull();
    expect(fromPersistedClipEdit({ segments: [] }, 10)).toBeNull();
  });
});
