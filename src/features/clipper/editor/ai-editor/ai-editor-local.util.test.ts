import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../../shared/utils/platform.util", () => ({ isTauri: () => false }));
import { listLocalModels, pickDefaultLocalModel, requestLocalEdit } from "./ai-editor-local.util";

afterEach(() => vi.unstubAllGlobals());

describe("local AI", () => {
  it("lists chat models and prefers a strong instruction model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "nomic-embed-text" }, { id: "llama3.2:3b" }, { id: "qwen3:14b" }] }))));
    const ids = await listLocalModels();
    expect(ids).toEqual(["llama3.2:3b", "qwen3:14b"]);
    expect(pickDefaultLocalModel(ids)).toBe("qwen3:14b");
  });
  it("uses Ollama's own API with a context sized to the prompt, and strips thinking", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen3:14b");
      expect(body.options.num_ctx).toBeGreaterThanOrEqual(8192);
      return new Response(JSON.stringify({ message: { content: '<think>hmm</think>\n{"summary":"ok","operations":[]}' } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestLocalEdit("qwen3:14b", [{ role: "user", content: "hi" }])).toBe('{"summary":"ok","operations":[]}');
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:11434/api/chat");
  });
  it("posts an OpenAI-style chat request to other servers (LM Studio)", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "http://localhost:1234/v1", setItem: () => {} });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestLocalEdit("m", [{ role: "user", content: "hi" }])).toBe("{}");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://localhost:1234/v1/chat/completions");
  });
});
