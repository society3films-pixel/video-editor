import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});

import { applyAiEditPlan, parseAiEditReply, wordSpan, type AiEditContext } from "./ai-editor-ops.util";
import { buildAiEditMessages, formatIndexedTranscript } from "./ai-editor-prompt.util";
import { pickDefaultModel } from "./ai-editor-client.util";
import { createInitialClipEdit, getOutputDuration } from "../clip-edit.util";
import type { WordCue } from "../../lib/media/transcription-export.util";

// "Hi there. Um, the weather is nice. Here is the big news." at 0.5 s per word.
const texts = ["Hi", "there.", "Um,", "the", "weather", "is", "nice.", "Here", "is", "the", "big", "news."];
const words: WordCue[] = texts.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
const duration = 6.2;
const context: AiEditContext = {
  duration,
  words,
  captionGroups: [{ start: 0, end: 1, words: words.slice(0, 2) }],
  aiShotBoundaries: [3],
  canChangeSource: true,
};
const base = () => ({ ...createInitialClipEdit(duration), framing: { keyframes: [], extraShotBoundaries: [] } });

describe("parsing the AI's reply", () => {
  it("reads JSON inside code fences and drops unknown operations", () => {
    const plan = parseAiEditReply('Sure!\n```json\n{"summary":"Tightened it.","operations":[{"op":"remove_fillers"},{"op":"explode"}]}\n```');
    expect(plan.summary).toBe("Tightened it.");
    expect(plan.operations).toEqual([{ op: "remove_fillers" }]);
  });

  it("explains unreadable replies", () => {
    expect(() => parseAiEditReply("I can't do that")).toThrow(/didn't return an edit plan/);
  });
});

describe("applying operations", () => {
  it("cuts a sentence by word numbers, including the silence around it", () => {
    const { edit, applied } = applyAiEditPlan(base(), { summary: "", operations: [{ op: "remove_words", from: 3, to: 6 }] }, context);
    expect(applied[0]).toMatch(/Cut “the weather is nice\.”/);
    const span = wordSpan(words, 3, 6, duration);
    expect(edit.segments.map((s) => [s.start, s.end])).toEqual([[0, span.start], [span.end, duration]]);
  });

  it("trims to a range, removes fillers and punches in, in a safe order", () => {
    const { edit, applied } = applyAiEditPlan(
      base(),
      {
        summary: "",
        operations: [
          { op: "punch_in", from_word: 10, to_word: 11, zoom: 1.2 },
          { op: "keep_only_words", from: 2, to: 11 },
          { op: "remove_fillers" },
        ],
      },
      context,
    );
    expect(applied).toHaveLength(3);
    expect(edit.segments[0]!.start).toBeGreaterThan(words[2]!.end - 0.01); // "Um," gone along with the intro
    expect(edit.segments.some((s) => s.zoom === 1.2 && s.start <= words[10]!.start && s.end >= words[11]!.end)).toBe(true);
  });

  it("places text in output time after cuts", () => {
    const { edit } = applyAiEditPlan(
      base(),
      { summary: "", operations: [{ op: "remove_words", from: 0, to: 6 }, { op: "add_text", text: "Big news", from_word: 7, to_word: 11 }] },
      context,
    );
    expect(edit.textOverlays[0]).toMatchObject({ text: "Big news", position: "top" });
    expect(edit.textOverlays[0]!.start).toBeLessThan(0.5);
    expect(getOutputDuration(edit.segments)).toBeLessThan(3.5);
  });

  it("skips invalid or unavailable operations with a reason", () => {
    const { edit, applied, skipped } = applyAiEditPlan(
      base(),
      {
        summary: "",
        operations: [
          { op: "remove_words", from: 0, to: 99 },
          { op: "remove_words", from: 0, to: 11 },
          { op: "edit_caption", line: 5, text: "x" },
        ],
      },
      context,
    );
    expect(applied).toEqual([]);
    expect(skipped).toHaveLength(3);
    expect(edit.segments).toHaveLength(1);
    const noSource = applyAiEditPlan(base(), { summary: "", operations: [{ op: "set_captions_visible", visible: false }] }, { ...context, canChangeSource: false });
    expect(noSource.skipped[0]).toMatch(/source video/);
  });

  it("edits captions, audio and framing", () => {
    const { edit, applied } = applyAiEditPlan(
      base(),
      {
        summary: "",
        operations: [
          { op: "edit_caption", line: 0, text: "Hello there." },
          { op: "set_volume", value: 1.4 },
          { op: "set_fades", in: 0.5, out: 9 },
          { op: "set_framing", shot: 1, layout: "split_ai" },
        ],
      },
      context,
    );
    expect(applied).toHaveLength(4);
    expect(edit.captionGroups![0]!.words.map((w) => w.text)).toEqual(["Hello", "there."]);
    expect(edit.volume).toBe(1.4);
    expect(edit.fadeOutSec).toBe(3);
    expect(edit.framing!.keyframes).toHaveLength(1);
    expect(edit.framing!.keyframes[0]).toMatchObject({ splitFollow: true });
    expect(edit.framing!.keyframes[0]!.t).toBeGreaterThan(3);
  });
});

describe("prompt and models", () => {
  it("numbers words and lists shots, captions and the current edit", () => {
    expect(formatIndexedTranscript(words).split("\n")[0]).toBe("0.0s: [0] Hi [1] there.");
    const [system, user] = buildAiEditMessages("cut the weather bit", base(), { ...context, shotBoundaries: [3], title: "News" });
    expect(system!.content).toMatch(/remove_words/);
    expect(user!.content).toMatch(/\[4\] weather/);
    expect(user!.content).toMatch(/Shots:\n0: 0\.0s-3\.0s\n1: 3\.0s-6\.2s/);
    expect(user!.content).toMatch(/Instruction: cut the weather bit/);
  });

  it("picks Claude Sonnet on OpenRouter and a large chat model on Groq", () => {
    expect(
      pickDefaultModel("openrouter", ["openai/gpt-x", "anthropic/claude-haiku-5", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-5.5"]),
    ).toBe("anthropic/claude-sonnet-5.5");
    expect(pickDefaultModel("groq", ["whisper-large-v3", "llama-3.1-8b-instant", "openai/gpt-oss-120b"])).toBe("openai/gpt-oss-120b");
    expect(pickDefaultModel("groq", ["whisper-large-v3"])).toBeNull();
  });
});

describe("Claude provider", () => {
  it("defaults to Claude Opus 5.5 when the account has it", async () => {
    const { pickDefaultClaudeModel } = await import("./ai-editor-anthropic.util");
    expect(pickDefaultClaudeModel(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"])).toBe("claude-opus-5-5");
    expect(pickDefaultClaudeModel(["claude-sonnet-5-5", "claude-opus-5"])).toBe("claude-opus-5");
    expect(pickDefaultClaudeModel([])).toBeNull();
  });
});
