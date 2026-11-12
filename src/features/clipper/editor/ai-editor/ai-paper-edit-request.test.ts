import { beforeEach, describe, expect, it, vi } from "vitest";

const requestEdit = vi.fn();
vi.mock("./ai-editor-providers.util", () => ({
  requestEdit: (...args: unknown[]) => requestEdit(...args),
}));

import { buildPaperEdit, buildPaperEditMessages } from "./ai-paper-edit.util";
import { contextFor } from "./ai-editor-local.util";

const words = Array.from({ length: 600 }, (_, i) => ({
  text: i % 10 === 9 ? `w${i}.` : `w${i}`,
  start: i * 0.4,
  end: i * 0.4 + 0.3,
}));
const local = { provider: "local" as const, model: "m" };

describe("paper edit requests", () => {
  beforeEach(() => {
    requestEdit.mockReset();
  });

  it("sends sentence lines with word ranges, not every word numbered, and repeats the format at the end", () => {
    const [, user] = buildPaperEditMessages(words, 5, "");
    expect(user!.content).toContain("[0-9] 0:00 w0 w1");
    expect(user!.content).not.toContain("[1] w1");
    expect(
      user!.content
        .trim()
        .endsWith('"to" the last number of a (later or same) line\'s range.'),
    ).toBe(true);
  });

  it("asks again when the first reply isn't JSON", async () => {
    requestEdit
      .mockResolvedValueOnce("Sure! Here is a great story about the musician…")
      .mockResolvedValueOnce(
        '{"title":"T","parts":[{"title":"A","from":0,"to":19}]}',
      );
    const edit = await buildPaperEdit(local, words, 5, "");
    expect(requestEdit).toHaveBeenCalledTimes(2);
    expect(edit.parts[0]).toMatchObject({ wordStartIdx: 0, wordEndIdx: 19 });
  });

  it("says what the model replied when it never gives JSON", async () => {
    requestEdit.mockResolvedValue("I cannot do that.");
    await expect(buildPaperEdit(local, words, 5, "")).rejects.toThrow(
      /it replied: "I cannot do that\."/,
    );
  });

  it("shortlists long transcripts section by section before building the story", async () => {
    const long = Array.from({ length: 30000 }, (_, i) => ({
      text: i % 12 === 11 ? `word${i}.` : `word${i}`,
      start: i * 0.4,
      end: i * 0.4 + 0.3,
    }));
    requestEdit.mockImplementation(
      async (
        _p: unknown,
        _m: unknown,
        messages: Array<{ content: string }>,
      ) => {
        const text = messages[1]!.content;
        if (text.includes('{"keep"')) {
          const first = /\[(\d+)-(\d+)\]/.exec(text)!;
          return JSON.stringify({
            keep: [[Number(first[1]), Number(first[2])]],
          });
        }
        return '{"title":"T","parts":[{"title":"A","from":0,"to":11}]}';
      },
    );
    const edit = await buildPaperEdit(local, long, 10, "");
    expect(requestEdit.mock.calls.length).toBeGreaterThan(2);
    const final = requestEdit.mock.calls.at(-1)![2] as Array<{
      content: string;
    }>;
    expect(final[1]!.content.length).toBeLessThan(18000 * 3.6);
    expect(edit.parts).toHaveLength(1);
  });

  it("sizes Ollama's context to the prompt", () => {
    expect(contextFor([{ content: "x".repeat(100) }], 4000)).toBe(8192);
    expect(contextFor([{ content: "x".repeat(64000) }], 4000)).toBe(28672);
    expect(contextFor([{ content: "x".repeat(10_000_000) }], 4000)).toBe(65536);
  });
});
