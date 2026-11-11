import React, { useEffect, useRef, useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { FolderPlus, Sparkles, X } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import type { WordCue } from "../lib/media/transcription-export.util";
import { getOutputDuration, type ClipEdit } from "./clip-edit.util";
import { Section, fieldStyle } from "./clipper-editor-side-panel.component";
import { resolveAiChoice } from "./ai-editor/ai-choice.util";
import {
  addBrollFiles,
  insertForSuggestion,
  loadBrollLibrary,
  saveBrollLibrary,
  suggestBroll,
  tagWithAi,
  type BrollItem,
} from "./broll-library.util";

/** The project's B-roll shots, their tags, and where they fit this clip. */
export const ClipperBrollLibrary: React.FC<{
  projectId: string;
  edit: ClipEdit;
  words: readonly WordCue[];
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
}> = ({ projectId, edit, words, onChange }) => {
  const { theme } = useClipperUi();
  const [items, setItems] = useState<BrollItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadBrollLibrary(projectId).then(setItems);
  }, [projectId]);

  const suggestions = suggestBroll(edit, words, items);
  const outputDuration = getOutputDuration(edit.segments);

  const tagAll = async () => {
    setBusy("Tagging with AI…");
    setNote(null);
    try {
      const choice = await resolveAiChoice();
      const next = [...items];
      for (const [index, item] of next.entries()) {
        setBusy(`Tagging ${index + 1}/${next.length}…`);
        next[index] = { ...item, tags: await tagWithAi(choice, item) };
      }
      setItems(await saveBrollLibrary(projectId, next));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="B-roll library">
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,video/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (!files.length) return;
          setBusy(`Adding ${files.length} shot${files.length === 1 ? "" : "s"}…`);
          void addBrollFiles(projectId, files)
            .then(setItems)
            .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
            .finally(() => setBusy(null));
        }}
      />
      <HStack gap={2} flexWrap="wrap">
        <OutlinedActionButton h="28px" px={2} fontSize="xs" startIcon={<FolderPlus size={13} />} onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
          Add shots
        </OutlinedActionButton>
        {items.length ? (
          <OutlinedActionButton h="28px" px={2} fontSize="xs" startIcon={<Sparkles size={13} />} onClick={() => void tagAll()} disabled={Boolean(busy)}>
            Tag with AI
          </OutlinedActionButton>
        ) : null}
        {busy ? (
          <HStack gap={1}>
            <Spinner size="xs" />
            <Text fontSize="xs">{busy}</Text>
          </HStack>
        ) : null}
      </HStack>
      <Text fontSize="xs" color={theme.text.muted}>
        Shots are shared by every clip in this project. Tags come from file names; Tag with AI looks at each shot (needs
        Claude or a local vision model, e.g. qwen2.5vl in Ollama).
      </Text>
      {suggestions.length ? (
        <VStack align="stretch" gap={1} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
          <HStack justify="space-between">
            <Text fontSize="xs" fontWeight="semibold">
              Fits this clip
            </Text>
            <Box
              as="button"
              fontSize="xs"
              cursor="pointer"
              onClick={() => onChange((current) => ({ ...current, inserts: [...(current.inserts ?? []), ...suggestions.map((s) => insertForSuggestion(s, outputDuration))] }))}
            >
              Add all
            </Box>
          </HStack>
          {suggestions.map((s) => (
            <HStack key={s.item.id} gap={2}>
              <Text fontSize="xs" flex={1}>
                {Math.floor(s.outputTime / 60)}:{String(Math.floor(s.outputTime % 60)).padStart(2, "0")} “{s.word}” → {s.item.name}
              </Text>
              <OutlinedActionButton
                h="24px"
                px={2}
                fontSize="xs"
                onClick={() => onChange((current) => ({ ...current, inserts: [...(current.inserts ?? []), insertForSuggestion(s, outputDuration)] }))}
              >
                Add
              </OutlinedActionButton>
            </HStack>
          ))}
        </VStack>
      ) : items.length ? (
        <Text fontSize="xs" color={theme.text.muted}>
          No tags match what's said in this clip yet.
        </Text>
      ) : null}
      <VStack align="stretch" gap={1} maxH="220px" overflowY="auto">
        {items.map((item) => (
          <HStack key={item.id} gap={2} align="start">
            {item.thumb ? <img src={item.thumb} alt="" style={{ width: 56, height: 32, objectFit: "cover", borderRadius: 4 }} /> : null}
            <VStack align="stretch" gap={0} flex={1} minW={0}>
              <Text fontSize="xs" truncate title={item.name}>
                {item.name}
              </Text>
              <input
                defaultValue={item.tags.join(", ")}
                onBlur={(e) => {
                  const tags = e.target.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
                  void saveBrollLibrary(projectId, items.map((i) => (i.id === item.id ? { ...i, tags } : i))).then(setItems);
                }}
                aria-label={`Tags for ${item.name}`}
                style={{ ...fieldStyle, padding: "1px 4px", fontSize: 11 }}
              />
            </VStack>
            <Box
              as="button"
              aria-label="Remove from library"
              cursor="pointer"
              onClick={() => void saveBrollLibrary(projectId, items.filter((i) => i.id !== item.id)).then(setItems)}
            >
              <X size={12} />
            </Box>
          </HStack>
        ))}
      </VStack>
      {note ? (
        <Text fontSize="xs" color={theme.status.danger}>
          {note}
        </Text>
      ) : null}
    </Section>
  );
};
