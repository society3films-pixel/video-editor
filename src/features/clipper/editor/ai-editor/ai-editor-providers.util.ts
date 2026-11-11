/** One interface over the AI editor's providers: Claude directly, or OpenRouter / Groq. */
import {
  availableAiEditorProviders,
  listAiEditorModels,
  pickDefaultModel,
  PROVIDER_LABEL as OPENAI_COMPATIBLE_LABEL,
  requestAiEdit,
  type AiEditorProvider as OpenAiCompatibleProvider,
} from "./ai-editor-client.util";
import {
  getAnthropicKey,
  listClaudeModels,
  pickDefaultClaudeModel,
  requestClaudeEdit,
} from "./ai-editor-anthropic.util";
import { listLocalModels, localAiAvailable, pickDefaultLocalModel, requestLocalEdit } from "./ai-editor-local.util";

export type AiProvider = "anthropic" | "local" | OpenAiCompatibleProvider;

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: "Claude (Anthropic)",
  local: "Local model (Ollama / LM Studio)",
  ...OPENAI_COMPATIBLE_LABEL,
};

export interface AiProviderStatus {
  provider: AiProvider;
  hasKey: boolean;
}

/**
 * Claude and the local model are always listed (set up in the AI tab); others only with a saved
 * key. "hasKey" for the local model means a server answered at its address.
 */
export async function aiProviderStatuses(): Promise<AiProviderStatus[]> {
  const [anthropicKey, others, local] = await Promise.all([
    getAnthropicKey(),
    availableAiEditorProviders().catch(() => []),
    localAiAvailable(),
  ]);
  return [
    { provider: "anthropic", hasKey: Boolean(anthropicKey) },
    { provider: "local", hasKey: local },
    ...others.map((provider) => ({ provider, hasKey: true })),
  ];
}

export function listModels(provider: AiProvider, signal?: AbortSignal): Promise<string[]> {
  if (provider === "local") return listLocalModels(signal);
  return provider === "anthropic" ? listClaudeModels() : listAiEditorModels(provider, signal);
}

export function defaultModel(provider: AiProvider, ids: readonly string[]): string | null {
  if (provider === "local") return pickDefaultLocalModel(ids);
  return provider === "anthropic" ? pickDefaultClaudeModel(ids) : pickDefaultModel(provider, ids);
}

export function requestEdit(
  provider: AiProvider,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  if (provider === "local") return requestLocalEdit(model, messages, signal);
  return provider === "anthropic" ? requestClaudeEdit(model, messages, signal) : requestAiEdit(provider, model, messages, signal);
}
