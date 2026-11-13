/**
 * The AI provider and model the user last chose (in the editor's AI tab), shared by every AI
 * feature: clip picking, social metadata and batch editing.
 */
import { aiProviderStatuses, defaultModel, listModels, AI_PROVIDER_LABEL, type AiProvider } from "./ai-editor-providers.util";

const STORAGE_KEY = "openclipper.ai.choice";

export interface AiChoice {
  provider: AiProvider;
  model: string;
}

export function loadAiChoice(): AiChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<AiChoice>) : null;
    return value?.provider && value.model ? { provider: value.provider, model: value.model } : null;
  } catch {
    return null;
  }
}

export function saveAiChoice(choice: AiChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Not remembered when storage is unavailable.
  }
}

/**
 * The saved choice if its provider is still ready; otherwise a model on this computer when one is
 * running (free, private, offline), then the first ready cloud provider.
 */
export async function resolveAiChoice(): Promise<AiChoice> {
  const statuses = await aiProviderStatuses();
  const ready = statuses.filter((status) => status.hasKey).map((status) => status.provider);
  const saved = loadAiChoice();
  if (saved && ready.includes(saved.provider)) return saved;
  const provider = ready.includes("local") ? "local" : ready[0];
  if (!provider) {
    throw new Error("No AI is set up yet. Open a clip's editor, go to the AI tab and add an Anthropic (Claude) key or connect a local model (Ollama / LM Studio).");
  }
  const model = defaultModel(provider, await listModels(provider));
  if (!model) throw new Error(`No usable models were found for ${AI_PROVIDER_LABEL[provider]}.`);
  return { provider, model };
}

export function describeAiChoice(choice: AiChoice): string {
  return `${AI_PROVIDER_LABEL[choice.provider]} · ${choice.model}`;
}
