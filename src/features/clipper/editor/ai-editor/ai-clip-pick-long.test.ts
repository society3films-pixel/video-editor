import { beforeEach, describe, expect, it, vi } from "vitest";

const requestEdit = vi.fn();
vi.mock("./ai-editor-providers.util", () => ({
  requestEdit: (...args: unknown[]) => requestEdit(...args),
}));

import { pickClipsWithAi } from "./ai-clip-pick.util";

const local = { provider: "local" as const, model: "m" };
// About two hours of talking: a sentence every 12 words.
const words = Array.from({ length: 36000 }, (_, i) => ({
  text: i % 12 === 11 ? `word${i}.` : `word${i}`,
  start: i * 0.2,
  end: i * 0.2 + 0.15,
}));

describe("AI clip picking on a long video", () => {
  beforeEach(() => {
    requestEdit.mockReset();
  });

  it("reads it in sections, then ranks the candidates, all within the model's budget", async () => {
    const sizes: number[] = [];
    requestEdit.mockImplementation(
      async (
        _p: unknown,
        _m: unknown,
        messages: Array<{ content: string }>,
      ) => {
        const text = messages[1]!.content;
        sizes.push(messages.reduce((n, m) => n + m.content.length, 0));
        if (text.includes('{"best"'))
          return JSON.stringify({ best: ["C4", "C1", "C2"] });
        // Two 24-word (≈4.8 s × 2 lines) clips from the first lines of the section.
        const ranges = [...text.matchAll(/\[(\d+)-(\d+)\]/g)].map((m) => [
          Number(m[1]),
          Number(m[2]),
        ]);
        const clip = (k: number) => ({
          title: `c${ranges[k]![0]}`,
          score: 5 + k,
          segments: [{ from: ranges[k]![0], to: ranges[k + 4]![1] }],
        });
        return JSON.stringify({ clips: [clip(0), clip(10)] });
      },
    );
    const steps: string[] = [];
    const picked = await pickClipsWithAi(
      local,
      words,
      { count: 3, minSec: 8, maxSec: 20, focus: "" },
      { onProgress: (s) => steps.push(s) },
    );
    expect(steps.some((s) => /part 2 of/.test(s))).toBe(true);
    expect(steps.at(-1)).toMatch(/Choosing the best 3/);
    expect(picked.clips).toHaveLength(3);
    // The ranking's first choice (C4) comes first.
    expect(picked.clips[0]!.title).not.toBe(picked.clips[1]!.title);
    // Every request fits a local model's context (about 18k tokens ≈ 65k characters, plus instructions).
    expect(Math.max(...sizes)).toBeLessThan(70000);
  });

  it("reads a 45-minute interview in ~10-minute sections on a local model", async () => {
    const interview = Array.from({ length: 7000 }, (_, i) => ({
      text: i % 12 === 11 ? `w${i}.` : `w${i}`,
      start: i * 0.4,
      end: i * 0.4 + 0.3,
    }));
    let sections = 0;
    requestEdit.mockImplementation(
      async (
        _p: unknown,
        _m: unknown,
        messages: Array<{ content: string }>,
      ) => {
        const text = messages[1]!.content;
        if (text.includes('{"best"'))
          return JSON.stringify({ best: ["C1", "C2"] });
        sections++;
        const first = /\[(\d+)-(\d+)\]/.exec(text)!;
        return JSON.stringify({
          clips: [
            {
              title: "c",
              score: 7,
              segments: [{ from: Number(first[1]), to: Number(first[1]) + 60 }],
            },
          ],
        });
      },
    );
    const picked = await pickClipsWithAi(local, interview, {
      count: 2,
      minSec: 15,
      maxSec: 40,
      focus: "",
    });
    expect(sections).toBeGreaterThanOrEqual(3);
    expect(picked.clips).toHaveLength(2);
  });
});
