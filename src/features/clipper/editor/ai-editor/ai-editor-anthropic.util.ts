/**
 * Direct Claude access for the AI editor, through the official Anthropic SDK and the user's own
 * Anthropic API key (stored in the app's local database, like the transcription keys).
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  localRecordDelete,
  localRecordGet,
  localRecordPut,
} from "../../../../shared/persistence/local-database.util";

const KEY_NAMESPACE = "ai-editor-api-keys";
const KEY_ID = "anthropic";

/** The default Claude model for edit planning. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);
/** Models that accept `output_config.effort` (Haiku 4.5 / Sonnet 4.5 and older reject it). */
const EFFORT_MODELS = /^claude-(opus|sonnet|haiku|fable|mythos)-5|^claude-opus-4-[5-8]|^claude-sonnet-4-6/;

interface StoredKey {
  apiKey: string;
  updatedAt: string;
}

export async function getAnthropicKey(): Promise<string | null> {
  const stored = await localRecordGet<StoredKey>(KEY_NAMESPACE, KEY_ID).catch(() => null);
  return stored?.apiKey?.trim() || null;
}

export async function saveAnthropicKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Paste your Anthropic API key first.");
  await localRecordPut<StoredKey>(KEY_NAMESPACE, KEY_ID, null, { apiKey: trimmed, updatedAt: new Date().toISOString() });
}

export async function removeAnthropicKey(): Promise<void> {
  await localRecordDelete(KEY_NAMESPACE, KEY_ID);
}

function createClient(apiKey: string): Anthropic {
  // The desktop app's webview counts as a browser to the SDK; the key is the user's own and
  // never leaves their machine except to call the API.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

async function requireClient(): Promise<Anthropic> {
  const key = await getAnthropicKey();
  if (!key) throw new Error("Add your Anthropic API key to use Claude.");
  return createClient(key);
}

/** Turns SDK errors into messages a user can act on. */
export function describeAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "Claude rejected the API key. Check it in the AI tab.";
  if (error instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (error instanceof Anthropic.NotFoundError) return "That Claude model isn't available to your account. Pick another one.";
  if (error instanceof Anthropic.RateLimitError) return "Claude is rate-limiting this key. Wait a moment and try again.";
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check your internet connection.";
  if (error instanceof Anthropic.APIError) return `Claude error ${error.status ?? ""}: ${error.message}`.trim();
  return error instanceof Error ? error.message : String(error);
}

/** Checks a key by listing models with it. */
export async function verifyAnthropicKey(apiKey: string): Promise<void> {
  try {
    await createClient(apiKey.trim()).models.list({ limit: 1 });
  } catch (error) {
    throw new Error(describeAnthropicError(error));
  }
}

export async function listClaudeModels(): Promise<string[]> {
  const client = await requireClient();
  const ids: string[] = [];
  try {
    for await (const model of client.models.list()) ids.push(model.id);
  } catch (error) {
    throw new Error(describeAnthropicError(error));
  }
  return ids;
}

export function pickDefaultClaudeModel(ids: readonly string[]): string | null {
  if (ids.includes(DEFAULT_CLAUDE_MODEL)) return DEFAULT_CLAUDE_MODEL;
  return ids.find((id) => id.startsWith("claude-opus")) ?? ids[0] ?? null;
}

/**
 * Asks Claude for an edit plan. `messages` is the provider-neutral system + user pair built by
 * ai-editor-prompt.util; the reply text is parsed by parseAiEditReply.
 */
export async function requestClaudeEdit(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal?: AbortSignal,
): Promise<string> {
  const client = await requireClient();
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
  const useFallbacks = FALLBACK_MODELS.has(model);

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
        ...(EFFORT_MODELS.test(model) ? { output_config: { effort: "medium" as const } } : {}),
        // If a safety classifier declines, the API retries on a suitable model in the same call.
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    );
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError) throw error;
    throw new Error(describeAnthropicError(error));
  }

  if (response.stop_reason === "refusal") {
    const reason = response.stop_details?.explanation;
    throw new Error(`Claude declined this request${reason ? `: ${reason}` : "."} Try rephrasing the instruction.`);
  }
  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text.trim()) {
    throw new Error(
      response.stop_reason === "max_tokens" ? "Claude's reply was cut off. Try a shorter instruction." : "Claude returned an empty reply.",
    );
  }
  return text;
}
