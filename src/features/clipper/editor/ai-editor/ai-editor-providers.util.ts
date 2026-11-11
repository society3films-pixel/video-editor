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

export type AiProvider = "anthropic" | OpenAiCompatibleProvider;

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: "Claude (Anthropic)",
  ...OPENAI_COMPATIBLE_LABEL,
};

export interface AiProviderStatus {
  provider: AiProvider;
  hasKey: boolean;
}

/** Claude is always listed (its key can be added in the AI tab); others only with a saved key. */
export async function aiProviderStatuses(): Promise<AiProviderStatus[]> {
  const [anthropicKey, others] = await Promise.all([getAnthropicKey(), availableAiEditorProviders().catch(() => [])]);
  return [{ provider: "anthropic", hasKey: Boolean(anthropicKey) }, ...others.map((provider) => ({ provider, hasKey: true }))];
}

export function listModels(provider: AiProvider, signal?: AbortSignal): Promise<string[]> {
  return provider === "anthropic" ? listClaudeModels() : listAiEditorModels(provider, signal);
}

export function defaultModel(provider: AiProvider, ids: readonly string[]): string | null {
  return provider === "anthropic" ? pickDefaultClaudeModel(ids) : pickDefaultModel(provider, ids);
}

export function requestEdit(
  provider: AiProvider,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  return provider === "anthropic" ? requestClaudeEdit(model, messages, signal) : requestAiEdit(provider, model, messages, signal);
}
