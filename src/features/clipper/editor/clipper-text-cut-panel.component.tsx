import React, { useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { findInterviewQuestions, removeQuestions, type InterviewQuestion } from "./interviewer.util";
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
  /** Mouth movement of the on-screen person (to tell the interviewer's voice apart). */
  onMeasureMouth?: () => Promise<Array<{ t: number; activity: number }>>;
}> = ({ edit, words, currentTime, onChange, onSeek, onMeasureMouth }) => {
  const { theme } = useClipperUi();
  const sentences = splitSentences(words);
  const [questions, setQuestions] = useState<InterviewQuestion[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setBusy(true);
    try {
      const activity = onMeasureMouth ? await onMeasureMouth().catch(() => null) : null;
      const found = findInterviewQuestions(words, activity);
      setQuestions(found);
      setSelected(new Set(found.map((q) => q.from)));
    } finally {
      setBusy(false);
    }
  };
  const apply = (asCards: boolean) => {
    if (!questions) return;
    onChange((current) => removeQuestions(current, questions.filter((q) => selected.has(q.from)), asCards));
    setQuestions(null);
  };
  return (
    <>
    <Section title="Interviewer questions">
      <Text fontSize="xs" color={theme.text.muted}>
        Finds questions asked off camera (worded as questions, said while the person on camera isn't talking). Cut them,
        or cut them and show each as a card over the answer.
      </Text>
      <OutlinedActionButton h="28px" px={2} fontSize="xs" onClick={() => void find()} disabled={busy || words.length < 5}>
        {busy ? <Spinner size="xs" /> : null} Find questions
      </OutlinedActionButton>
      {questions ? (
        questions.length ? (
          <VStack align="stretch" gap={1}>
            {questions.map((q) => (
              <label key={q.from} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selected.has(q.from)}
                  onChange={(e) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(q.from);
                      else next.delete(q.from);
                      return next;
                    })
                  }
                  style={{ accentColor: clipperTheme.accent, marginTop: 2 }}
                />
                <span>
                  {formatEditorTime(q.start)} “{q.text}”{q.evidence === "question" ? " (from the wording only)" : ""}
                </span>
              </label>
            ))}
            <HStack gap={2}>
              <OutlinedActionButton h="28px" px={2} fontSize="xs" disabled={!selected.size} onClick={() => apply(false)}>
                Cut them
              </OutlinedActionButton>
              <OutlinedActionButton h="28px" px={2} fontSize="xs" disabled={!selected.size} onClick={() => apply(true)}>
                Cut and show as cards
              </OutlinedActionButton>
            </HStack>
          </VStack>
        ) : (
          <Text fontSize="xs" color={theme.text.muted}>
            No interviewer questions found.
          </Text>
        )
      ) : null}
    </Section>
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
    </>
  );
};
