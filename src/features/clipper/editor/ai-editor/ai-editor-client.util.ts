/**
 * Talks to an OpenAI-compatible chat endpoint using the Groq or OpenRouter key the user already
 * saved for cloud transcription.
 */
import { withImage, type AiImage } from "./ai-image.util";
import {
  transcriptionApiKeysService,
  type CloudTranscriptionProvider,
} from "../../../../services/transcription-api-keys.service";

export type AiEditorProvider = CloudTranscriptionProvider;

const CHAT_URL: Record<AiEditorProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

const MODELS_URL: Record<AiEditorProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
};

export const PROVIDER_LABEL: Record<AiEditorProvider, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
};

/** Providers with a saved key, OpenRouter first (it offers Claude). */
export async function availableAiEditorProviders(): Promise<AiEditorProvider[]> {
  const providers: AiEditorProvider[] = ["openrouter", "groq"];
  const checks = await Promise.all(
    providers.map(async (provider) => ((await transcriptionApiKeysService.getPublic(provider).catch(() => null))?.isKeyConfigured ? provider : null)),
  );
  return checks.filter((provider): provider is AiEditorProvider => provider !== null);
}

async function requireKey(provider: AiEditorProvider): Promise<string> {
  const key = await transcriptionApiKeysService.get(provider);
  if (!key) throw new Error(`No ${PROVIDER_LABEL[provider]} API key saved. Add one in Settings → Transcription.`);
  return key;
}

/** Speech, embedding and moderation models can't edit; keep chat models only. */
const NOT_CHAT = /whisper|tts|speech|audio|embed|guard|moderation|playai|orpheus|distil|vision-only|image/i;

/**
 * A sensible default from the provider's own model list. OpenRouter: the newest Claude Sonnet,
 * then any Claude, then the first model. Groq: a large general model.
 */
export function pickDefaultModel(provider: AiEditorProvider, ids: readonly string[]): string | null {
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  if (chat.length === 0) return null;
  const newestFirst = (list: string[]) => [...list].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (provider === "openrouter") {
    const sonnet = newestFirst(chat.filter((id) => /^anthropic\/claude.*sonnet/i.test(id)));
    if (sonnet[0]) return sonnet[0];
    const claude = newestFirst(chat.filter((id) => /^anthropic\/claude/i.test(id)));
    if (claude[0]) return claude[0];
    return chat[0]!;
  }
  const preferred = [/gpt-oss-120b/i, /llama-4-maverick/i, /70b/i, /qwen3/i, /llama/i];
  for (const pattern of preferred) {
    const match = newestFirst(chat.filter((id) => pattern.test(id)))[0];
    if (match) return match;
  }
  return chat[0]!;
}

export async function listAiEditorModels(provider: AiEditorProvider, signal?: AbortSignal): Promise<string[]> {
  const key = await requireKey(provider);
  const response = await fetch(MODELS_URL[provider], { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!response.ok) throw new Error(`${PROVIDER_LABEL[provider]} rejected the key (HTTP ${response.status}).`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && !NOT_CHAT.test(id))
    .sort();
}

export async function requestAiEdit(
  provider: AiEditorProvider,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
  image?: AiImage,
): Promise<string> {
  const key = await requireKey(provider);
  const response = await fetch(CHAT_URL[provider], {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(provider === "openrouter" ? { "X-Title": "Open Clipper" } : {}),
    },
    body: JSON.stringify({ model, messages: withImage(messages, image), temperature: 0.2, max_tokens: 2000 }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${PROVIDER_LABEL[provider]} error (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("The AI returned an empty reply.");
  return content;
}
