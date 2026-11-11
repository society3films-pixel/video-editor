import React, { useEffect, useState } from "react";
import { Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Send } from "lucide-react";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { clipperTheme } from "../../shared/theme.util";
import { fieldStyle, Section } from "../clipper-editor-side-panel.component";
import {
  availableAiEditorProviders,
  listAiEditorModels,
  pickDefaultModel,
  PROVIDER_LABEL,
  type AiEditorProvider,
} from "./ai-editor-client.util";

export interface AiEditorTurn {
  instruction: string;
  summary: string;
  applied: string[];
  skipped: string[];
  error?: string;
}

interface ClipperAiEditorPanelProps {
  onRun: (instruction: string, provider: AiEditorProvider, model: string) => Promise<AiEditorTurn>;
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

function loadSavedModel(provider: AiEditorProvider): string | null {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY + provider);
  } catch {
    return null;
  }
}

function saveModel(provider: AiEditorProvider, model: string): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY + provider, model);
  } catch {
    // Storage unavailable: the choice just isn't remembered.
  }
}

export const ClipperAiEditorPanel: React.FC<ClipperAiEditorPanelProps> = ({ onRun, hasTranscript, disabled }) => {
  const { theme } = useClipperUi();
  const [providers, setProviders] = useState<AiEditorProvider[] | null>(null);
  const [provider, setProvider] = useState<AiEditorProvider | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [modelError, setModelError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [turns, setTurns] = useState<AiEditorTurn[]>([]);

  useEffect(() => {
    let cancelled = false;
    void availableAiEditorProviders().then((list) => {
      if (cancelled) return;
      setProviders(list);
      setProvider(list[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    setModelError(null);
    setModels([]);
    listAiEditorModels(provider, controller.signal)
      .then((ids) => {
        setModels(ids);
        const saved = loadSavedModel(provider);
        setModel(saved && ids.includes(saved) ? saved : pickDefaultModel(provider, ids) ?? "");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setModelError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [provider]);

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

  if (providers.length === 0) {
    return (
      <Section title="AI editor">
        <Text fontSize="sm">The AI editor uses your OpenRouter or Groq API key.</Text>
        <Text fontSize="xs" color={theme.text.muted}>
          Add one in Settings → Transcription (the same keys used for cloud transcription), then reopen the editor.
          OpenRouter gives access to Claude and many other models; you pay the provider per request (usually a fraction
          of a cent per edit).
        </Text>
      </Section>
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
            onChange={(event) => setProvider(event.target.value as AiEditorProvider)}
            style={{ ...selectStyle, width: 120 }}
            aria-label="AI provider"
            disabled={running}
          >
            {providers.map((item) => (
              <option key={item} value={item}>
                {PROVIDER_LABEL[item]}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              if (provider) saveModel(provider, event.target.value);
            }}
            style={selectStyle}
            aria-label="AI model"
            disabled={running || models.length === 0}
          >
            {models.length === 0 ? <option value="">{modelError ? "Couldn't load models" : "Loading models…"}</option> : null}
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </HStack>
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
          disabled={running || disabled}
          aria-label="Instruction for the AI editor"
        />
        <Button
          size="sm"
          bg={clipperTheme.accent}
          color="white"
          _hover={{ bg: clipperTheme.accentHover }}
          onClick={() => void run(instruction)}
          disabled={!instruction.trim() || !model || running || disabled}
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
