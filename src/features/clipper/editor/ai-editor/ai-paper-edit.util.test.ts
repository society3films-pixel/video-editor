import { describe, expect, it } from "vitest";
import { parsePaperEdit } from "./ai-paper-edit.util";

describe("paper edit with separate performances", () => {
  it("keeps known performance takes once and drops unknown ones", () => {
    const words = Array.from({ length: 20 }, (_, i) => ({
      text: `w${i}`,
      start: i,
      end: i + 0.8,
    }));
    const reply = JSON.stringify({
      title: "Story",
      parts: [
        { title: "Open", from: 0, to: 5 },
        { title: "Song", performance: "P1" },
        { title: "Again", performance: "P1" },
        { title: "Ghost", performance: "P9" },
        { title: "End", from: 10, to: 15 },
      ],
    });
    const edit = parsePaperEdit(reply, words, [
      { id: "P1", label: "song.mp4", durationSec: 200 },
    ]);
    expect(edit.parts.map((p) => p.kind)).toEqual([
      "talk",
      "performance",
      "talk",
    ]);
    expect(edit.parts[1]).toMatchObject({ performanceId: "P1", endSec: 200 });
  });
});
