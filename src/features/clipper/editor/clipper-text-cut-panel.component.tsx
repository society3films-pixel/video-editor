import React from "react";
import { Box, Text, VStack } from "@chakra-ui/react";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { WordCue } from "../lib/media/transcription-export.util";
import { cutSourceRange, formatEditorTime, type ClipEdit } from "./clip-edit.util";
import { Section } from "./clipper-editor-side-panel.component";
import { splitSentences } from "./hook.util";
import { keptShare, restoreSourceRange } from "./text-cut.util";

/** The transcript as sentences: click one to cut it, click again to bring it back. */
export const ClipperTextCutPanel: React.FC<{
  edit: ClipEdit;
  words: readonly WordCue[];
  currentTime: number;
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
  onSeek: (localTime: number) => void;
}> = ({ edit, words, currentTime, onChange, onSeek }) => {
  const { theme } = useClipperUi();
  const sentences = splitSentences(words);
  return (
    <Section title="Edit by text">
      <Text fontSize="xs" color={theme.text.muted}>
        Click a sentence to cut it; click it again to bring it back. Right-click to jump there. Undo works as usual.
      </Text>
      <VStack align="stretch" gap={1}>
        {sentences.map((sentence) => {
          const start = Math.max(0, sentence.start - 0.08);
          const end = sentence.end + 0.12;
          const kept = keptShare(edit, sentence.start, sentence.end) > 0.5;
          const active = currentTime >= sentence.start && currentTime < sentence.end;
          return (
            <Box
              key={`${sentence.from}-${sentence.to}`}
              as="button"
              textAlign="left"
              fontSize="sm"
              p={1.5}
              borderRadius="md"
              cursor="pointer"
              border="1px solid"
              borderColor={active ? clipperTheme.accentGlow : "transparent"}
              color={kept ? theme.text.primary : theme.text.muted}
              textDecoration={kept ? "none" : "line-through"}
              bg={kept ? "transparent" : "rgba(0,0,0,0.25)"}
              _hover={{ bg: "rgba(255,255,255,0.05)" }}
              title={kept ? "Cut this sentence" : "Bring it back"}
              onClick={() => onChange((current) => (kept ? cutSourceRange(current, start, end) : restoreSourceRange(current, start, end)))}
              onContextMenu={(e) => {
                e.preventDefault();
                onSeek(sentence.start + 0.01);
              }}
            >
              <Text as="span" fontSize="10px" fontFamily="mono" color={theme.text.muted} mr={2}>
                {formatEditorTime(sentence.start)}
              </Text>
              {sentence.text}
            </Box>
          );
        })}
      </VStack>
    </Section>
  );
};
