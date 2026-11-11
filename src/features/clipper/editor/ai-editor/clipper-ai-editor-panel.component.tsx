import React, { useEffect, useState } from "react";
import { Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Send } from "lucide-react";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { clipperTheme } from "../../shared/theme.util";
import { fieldStyle, Section } from "../clipper-editor-side-panel.component";
import {
  AI_PROVIDER_LABEL,
  aiProviderStatuses,
  defaultModel,
  listModels,
  type AiProvider,
  type AiProviderStatus,
} from "./ai-editor-providers.util";
import { removeAnthropicKey, saveAnthropicKey, verifyAnthropicKey } from "./ai-editor-anthropic.util";
import { getLocalAiUrl, LOCAL_AI_PRESETS, listLocalModels, setLocalAiUrl } from "./ai-editor-local.util";
import { loadAiChoice, saveAiChoice } from "./ai-choice.util";

export interface AiEditorTurn {
  instruction: string;
  summary: string;
  applied: string[];
  skipped: string[];
  error?: string;
}

interface ClipperAiEditorPanelProps {
  onRun: (instruction: string, provider: AiProvider, model: string) => Promise<AiEditorTurn>;
  hasTranscript: boolean;
  disabled: boolean;
}

const SUGGESTIONS = [
  "Make it punchier: cut anything that doesn't move the story forward",
  "Cut the intro and start on the most interesting line",
  "Add a short hook title for the first few seconds",
  "Punch in on the most important sentence",
  "Fix any caption spelling mistakes",
];

const MODEL_STORAGE_KEY = "openclipper.aiEditor.model.";

function loadSavedModel(provider: AiProvider): string | null {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY + provider);
  } catch {
    return null;
  }
}

function saveModel(provider: AiProvider, model: string): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY + provider, model);
  } catch {
    // Storage unavailable: the choice just isn't remembered.
  }
}

export const ClipperAiEditorPanel: React.FC<ClipperAiEditorPanelProps> = ({ onRun, hasTranscript, disabled }) => {
  const { theme } = useClipperUi();
  const [providers, setProviders] = useState<AiProviderStatus[] | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [modelsVersion, setModelsVersion] = useState(0);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [modelError, setModelError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [turns, setTurns] = useState<AiEditorTurn[]>([]);

  useEffect(() => {
    let cancelled = false;
    void aiProviderStatuses().then((list) => {
      if (cancelled) return;
      setProviders(list);
      // The last choice if it's still ready; else a ready provider (Claude is listed first so its key can be added here).
      const saved = loadAiChoice();
      const savedReady = saved && list.some((item) => item.provider === saved.provider && item.hasKey);
      setProvider(savedReady ? saved.provider : (list.find((item) => item.hasKey) ?? list[0])?.provider ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const providerReady = Boolean(providers?.find((item) => item.provider === provider)?.hasKey);

  const saveKey = async () => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      await verifyAnthropicKey(keyDraft);
      await saveAnthropicKey(keyDraft);
      setKeyDraft("");
      setProviders((list) => list?.map((item) => (item.provider === "anthropic" ? { ...item, hasKey: true } : item)) ?? list);
      setModelsVersion((value) => value + 1);
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeyBusy(false);
    }
  };

  const [localUrl, setLocalUrlDraft] = useState(getLocalAiUrl);
  const connectLocal = async () => {
    setKeyBusy(true);
    setKeyError(null);
    setLocalAiUrl(localUrl);
    try {
      const ids = await listLocalModels();
      if (ids.length === 0) throw new Error("The server answered but has no models. Pull one first, e.g. ollama pull qwen3:14b");
      setProviders((list) => list?.map((item) => (item.provider === "local" ? { ...item, hasKey: true } : item)) ?? list);
      setModelsVersion((value) => value + 1);
    } catch (error) {
      setProviders((list) => list?.map((item) => (item.provider === "local" ? { ...item, hasKey: false } : item)) ?? list);
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeyBusy(false);
    }
  };

  const forgetKey = async () => {
    await removeAnthropicKey();
    setModels([]);
    setModel("");
    setProviders((list) => list?.map((item) => (item.provider === "anthropic" ? { ...item, hasKey: false } : item)) ?? list);
  };

  useEffect(() => {
    if (!provider || !providerReady) return;
    const controller = new AbortController();
    setModelError(null);
    setModels([]);
    listModels(provider, controller.signal)
      .then((ids) => {
        if (controller.signal.aborted) return;
        setModels(ids);
        const saved = loadSavedModel(provider);
        const chosen = saved && ids.includes(saved) ? saved : defaultModel(provider, ids) ?? "";
        setModel(chosen);
        if (chosen) saveAiChoice({ provider, model: chosen });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setModelError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [provider, providerReady, modelsVersion]);

  const run = async (text: string) => {
    if (!provider || !model || !text.trim() || running) return;
    setRunning(true);
    try {
      const turn = await onRun(text.trim(), provider, model);
      setTurns((items) => [turn, ...items]);
      if (!turn.error) setInstruction("");
    } finally {
      setRunning(false);
    }
  };

  if (providers === null) {
    return (
      <HStack gap={2} p={4}>
        <Spinner size="xs" />
        <Text fontSize="sm">Checking your API keys…</Text>
      </HStack>
    );
  }

  const selectStyle: React.CSSProperties = { ...fieldStyle, padding: "4px 6px" };

  return (
    <VStack align="stretch" gap={3}>
      <Section title="AI editor">
        <Text fontSize="xs" color={theme.text.muted}>
          Describe the edit you want. The AI reads the transcript and makes cuts, zooms, text, caption, audio and framing
          changes you can review and undo (Ctrl+Z).
        </Text>
        {!hasTranscript ? (
          <Text fontSize="xs" color={theme.status.danger}>
            This clip has no transcript here, so the AI can only change audio and fades.
          </Text>
        ) : null}
        <HStack gap={2}>
          <select
            value={provider ?? ""}
            onChange={(event) => setProvider(event.target.value as AiProvider)}
            style={{ ...selectStyle, width: 150 }}
            aria-label="AI provider"
            disabled={running}
          >
            {providers.map((item) => (
              <option key={item.provider} value={item.provider}>
                {AI_PROVIDER_LABEL[item.provider]}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              if (provider) {
                saveModel(provider, event.target.value);
                saveAiChoice({ provider, model: event.target.value });
              }
            }}
            style={selectStyle}
            aria-label="AI model"
            disabled={running || models.length === 0}
            hidden={!providerReady}
          >
            {models.length === 0 ? <option value="">{modelError ? "Couldn't load models" : "Loading models…"}</option> : null}
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </HStack>
        {provider === "anthropic" && !providerReady ? (
          <VStack align="stretch" gap={2} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
            <Text fontSize="xs">
              Paste an Anthropic API key to use Claude directly. Create one at console.anthropic.com → API Keys. It's
              stored only on this computer, and you pay Anthropic per request (a few cents at most for a short clip
              with the default Claude Opus 5.5).
            </Text>
            <HStack gap={2}>
              <input
                type="password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                placeholder="sk-ant-…"
                style={fieldStyle}
                aria-label="Anthropic API key"
                autoComplete="off"
              />
              <Button size="sm" onClick={() => void saveKey()} disabled={!keyDraft.trim() || keyBusy}>
                {keyBusy ? <Spinner size="xs" /> : "Save"}
              </Button>
            </HStack>
            {keyError ? (
              <Text fontSize="xs" color={theme.status.danger}>
                {keyError}
              </Text>
            ) : null}
            <Text fontSize="xs" color={theme.text.muted}>
              {providers.length > 1
                ? `Or switch to ${providers.filter((item) => item.provider !== "anthropic").map((item) => AI_PROVIDER_LABEL[item.provider]).join(" or ")} above.`
                : "You can also use an OpenRouter or Groq key from Settings → Transcription."}
            </Text>
          </VStack>
        ) : null}
        {provider === "local" ? (
          <VStack align="stretch" gap={2} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
            <Text fontSize="xs">
              Runs a model on this computer: free, private and offline. Install Ollama (ollama.com) and run{" "}
              <code>ollama pull qwen3:14b</code> (or another model that fits your GPU), or start LM Studio's local
              server. Bigger models follow edit instructions better.
            </Text>
            <HStack gap={2}>
              <input
                value={localUrl}
                onChange={(event) => setLocalUrlDraft(event.target.value)}
                style={fieldStyle}
                aria-label="Local AI server address"
              />
              <Button size="sm" onClick={() => void connectLocal()} disabled={keyBusy}>
                {keyBusy ? <Spinner size="xs" /> : providerReady ? "Reconnect" : "Connect"}
              </Button>
            </HStack>
            <HStack gap={3}>
              {LOCAL_AI_PRESETS.map((preset) => (
                <Box key={preset.label} as="button" fontSize="xs" color={clipperTheme.accentGlow} cursor="pointer" onClick={() => setLocalUrlDraft(preset.url)}>
                  {preset.label}
                </Box>
              ))}
            </HStack>
            {keyError ? (
              <Text fontSize="xs" color={theme.status.danger}>
                {keyError}
              </Text>
            ) : null}
          </VStack>
        ) : null}
        {provider === "anthropic" && providerReady ? (
          <Box as="button" alignSelf="flex-start" fontSize="xs" color={theme.text.muted} cursor="pointer" _hover={{ color: theme.status.danger }} onClick={() => void forgetKey()}>
            Remove Anthropic key
          </Box>
        ) : null}
        {modelError ? (
          <Text fontSize="xs" color={theme.status.danger}>
            {modelError}
          </Text>
        ) : null}
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void run(instruction);
          }}
          placeholder="e.g. Cut the part about the weather and add “Wait for it…” at the start"
          rows={3}
          style={{ ...fieldStyle, resize: "vertical", fontFamily: "inherit" }}
          disabled={running || disabled || !providerReady}
          aria-label="Instruction for the AI editor"
        />
        <Button
          size="sm"
          bg={clipperTheme.accent}
          color="white"
          _hover={{ bg: clipperTheme.accentHover }}
          onClick={() => void run(instruction)}
          disabled={!instruction.trim() || !model || !providerReady || running || disabled}
        >
          {running ? (
            <HStack gap={2}>
              <Spinner size="xs" />
              <Text>Editing…</Text>
            </HStack>
          ) : (
            <HStack gap={2}>
              <Send size={14} />
              <Text>Apply (Ctrl+Enter)</Text>
            </HStack>
          )}
        </Button>
        <VStack align="stretch" gap={1}>
          {SUGGESTIONS.map((suggestion) => (
            <Box
              key={suggestion}
              as="button"
              textAlign="left"
              fontSize="xs"
              px={2}
              py={1}
              borderRadius="sm"
              border="1px solid"
              borderColor={theme.surface.hover}
              color={theme.text.muted}
              cursor="pointer"
              _hover={{ color: theme.text.primary, borderColor: clipperTheme.accentGlow }}
              onClick={() => !running && setInstruction(suggestion)}
            >
              {suggestion}
            </Box>
          ))}
        </VStack>
      </Section>

      {turns.length > 0 ? (
        <Section title="History">
          {turns.map((turn, index) => (
            <VStack key={turns.length - index} align="stretch" gap={1} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
              <Text fontSize="xs" fontWeight="semibold">
                “{turn.instruction}”
              </Text>
              {turn.error ? (
                <Text fontSize="xs" color={theme.status.danger}>
                  {turn.error}
                </Text>
              ) : (
                <>
                  {turn.summary ? <Text fontSize="xs">{turn.summary}</Text> : null}
                  {turn.applied.map((line) => (
                    <Text key={line} fontSize="xs" color={theme.text.muted}>
                      ✓ {line}
                    </Text>
                  ))}
                  {turn.skipped.map((line) => (
                    <Text key={line} fontSize="xs" color={theme.status.danger}>
                      ✗ {line}
                    </Text>
                  ))}
                  {turn.applied.length === 0 && turn.skipped.length === 0 ? (
                    <Text fontSize="xs" color={theme.text.muted}>
                      No changes.
                    </Text>
                  ) : null}
                </>
              )}
            </VStack>
          ))}
        </Section>
      ) : null}
    </VStack>
  );
};
