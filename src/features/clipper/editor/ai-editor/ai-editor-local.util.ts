/**
 * A model running on this computer through an OpenAI-compatible server: Ollama
 * (http://localhost:11434/v1) or LM Studio (http://localhost:1234/v1). Nothing leaves the machine
 * and there's no per-request cost. In the desktop app requests go through a Rust command, because
 * these servers reject the app's web origin.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../../../shared/utils/platform.util";
import { withImage, type AiImage } from "./ai-image.util";

const URL_STORAGE_KEY = "openclipper.ai.localUrl";

export const LOCAL_AI_PRESETS = [
  { label: "Ollama", url: "http://localhost:11434/v1" },
  { label: "LM Studio", url: "http://localhost:1234/v1" },
] as const;

export function getLocalAiUrl(): string {
  try {
    return localStorage.getItem(URL_STORAGE_KEY) || LOCAL_AI_PRESETS[0].url;
  } catch {
    return LOCAL_AI_PRESETS[0].url;
  }
}

export function setLocalAiUrl(url: string): void {
  try {
    localStorage.setItem(URL_STORAGE_KEY, url.trim().replace(/\/+$/, ""));
  } catch {
    // Storage unavailable: the default is used.
  }
}

async function call(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${getLocalAiUrl()}${path}`;
  if (isTauri()) {
    const request = invoke<string>("local_ai_request", {
      url,
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!signal) return request;
    return Promise.race([
      request,
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      ),
    ]);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      "Couldn't reach the local AI server. Is Ollama or LM Studio running (with browser access allowed)?",
    );
  }
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `Local AI error (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  return text;
}

const NOT_CHAT = /embed|whisper|tts|rerank|clip|vision-only/i;

export async function listLocalModels(signal?: AbortSignal): Promise<string[]> {
  const body = JSON.parse(await call("/models", undefined, signal)) as {
    data?: Array<{ id?: string }>;
  };
  return (body.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && !NOT_CHAT.test(id))
    .sort();
}

/** Bigger, newer instruction models first; local lists are usually short. */
export function pickDefaultLocalModel(ids: readonly string[]): string | null {
  const preferred = [
    /qwen3/i,
    /gpt-oss/i,
    /llama-?3\.3|llama-?4/i,
    /gemma-?3/i,
    /mistral-small|mistral-nemo/i,
    /qwen2\.5/i,
    /llama/i,
  ];
  for (const pattern of preferred) {
    const match = ids.find((id) => pattern.test(id));
    if (match) return match;
  }
  return ids[0] ?? null;
}

/** Ollama's own address for the configured server (its native API takes a context size per request). */
function ollamaBase(): string | null {
  const url = getLocalAiUrl();
  return /:11434(\/|$)/.test(url) ? url.replace(/\/v1\/?$/, "") : null;
}

/** A context big enough for the request (Ollama's default is small and cuts long prompts from the start). */
export function contextFor(
  messages: ReadonlyArray<{ content: string }>,
  replyTokens: number,
): number {
  const promptTokens = Math.ceil(
    messages.reduce((n, m) => n + m.content.length, 0) / 3.2,
  );
  const needed = promptTokens + replyTokens + 1024;
  return Math.min(65536, Math.max(8192, Math.ceil(needed / 4096) * 4096));
}

const stripThinking = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export async function requestLocalEdit(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
  image?: AiImage,
): Promise<string> {
  const replyTokens = 4000;
  const ollama = ollamaBase();
  if (ollama) {
    // Native API: sets the context per request, so long transcripts aren't cut.
    const last = messages.map((m) => m.role).lastIndexOf("user");
    const body = {
      model,
      stream: false,
      messages: messages.map((m, i) =>
        i === last && image ? { ...m, images: [image.base64] } : m,
      ),
      options: {
        temperature: 0.2,
        num_ctx: contextFor(messages, replyTokens),
        num_predict: replyTokens,
      },
    };
    const url = `${ollama}/api/chat`;
    const text = isTauri()
      ? await invoke<string>("local_ai_request", {
          url,
          body: JSON.stringify(body),
        })
      : await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }).then(async (r) => {
          const t = await r.text();
          if (!r.ok)
            throw new Error(
              `Local AI error (HTTP ${r.status}): ${t.slice(0, 200)}`,
            );
          return t;
        });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const content = (JSON.parse(text) as { message?: { content?: string } })
      .message?.content;
    if (!content) throw new Error("The local model returned an empty reply.");
    return stripThinking(content);
  }
  const reply = JSON.parse(
    await call(
      "/chat/completions",
      {
        model,
        messages: withImage(messages, image),
        temperature: 0.2,
        max_tokens: replyTokens,
        stream: false,
      },
      signal,
    ),
  ) as { choices?: Array<{ message?: { content?: string } }> };
  const content = reply.choices?.[0]?.message?.content;
  if (!content) throw new Error("The local model returned an empty reply.");
  // Reasoning models (Qwen 3, DeepSeek R1) may include their thinking; keep only the answer.
  return stripThinking(content);
}

/** Whether a server answers at the saved address. */
export async function localAiAvailable(): Promise<boolean> {
  try {
    return (await listLocalModels()).length > 0;
  } catch {
    return false;
  }
}
