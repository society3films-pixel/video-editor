import React, { useState } from "react";
import { forgetLearnedFraming, LEARNED_LAYOUT_LABEL, learnedLayouts, SHOT_KIND_LABEL, type LearnedLayout, type ShotKind } from "../../editor/framing-learning.util";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { X } from "lucide-react";
import { OutlinedActionButton } from "../../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { ClipperFramingIssues } from "../../editor/clipper-framing-issues.component";
import type { FramingIssue } from "../../editor/framing-check.util";

export interface FramingReportEntry {
  clipIndex: number;
  issues: FramingIssue[] | null;
}

/** "Check framing" results for every clip in Preview, worst first, each with a Fix button. */
export const ClipperFramingReport: React.FC<{
  entries: FramingReportEntry[];
  formatLabel: string;
  onFix: (clipIndex: number) => void;
  onClose: () => void;
  /** Applies Auto-fix (built-in rules plus learned layouts) to every clip; returns how many shots changed. */
  onAutoFixAll?: () => Promise<number>;
}> = ({ entries, formatLabel, onFix, onClose, onAutoFixAll }) => {
  const [fixing, setFixing] = useState(false);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const learned = Object.entries(learnedLayouts()) as Array<[ShotKind, LearnedLayout]>;
  const { theme } = useClipperUi();
  const warnings = (entry: FramingReportEntry) => entry.issues?.filter((issue) => issue.severity === "warning").length ?? 0;
  const sorted = [...entries].sort((a, b) => warnings(b) - warnings(a) || (b.issues?.length ?? 0) - (a.issues?.length ?? 0) || a.clipIndex - b.clipIndex);
  const flagged = entries.filter((entry) => entry.issues?.length).length;
  return (
    <Box position="fixed" inset={0} zIndex={1400} bg="rgba(0,0,0,0.6)" display="flex" alignItems="center" justifyContent="center" p={4} onClick={onClose}>
      <VStack
        align="stretch"
        gap={3}
        w="min(640px, 100%)"
        maxH="85vh"
        overflowY="auto"
        p={5}
        borderRadius="2xl"
        bg={theme.background.card}
        border="1px solid"
        borderColor={theme.border.primary}
        onClick={(event) => event.stopPropagation()}
      >
        <HStack justify="space-between">
          <Text fontWeight="semibold">Framing check</Text>
          <Box as="button" aria-label="Close" onClick={onClose} cursor="pointer">
            <X size={18} />
          </Box>
        </HStack>
        <Text fontSize="xs" color={theme.text.muted}>
          {flagged
            ? `${flagged} of ${entries.length} clips may need a look (checked in ${formatLabel}). Fix opens the clip's framing editor.`
            : `All ${entries.length} clips look fine in ${formatLabel}.`}
        </Text>
        {onAutoFixAll ? (
          <VStack align="stretch" gap={1} p={3} borderRadius="lg" bg="rgba(0,0,0,0.2)">
            <HStack justify="space-between" gap={3} flexWrap="wrap">
              <Text fontSize="xs" color={theme.text.muted} flex={1} minW="200px">
                {learned.length
                  ? `Learned from your fixes: ${learned.map(([kind, layout]) => `${SHOT_KIND_LABEL[kind]} → ${LEARNED_LAYOUT_LABEL[layout]}`).join("; ")}.`
                  : "Auto-fix uses split screen where two people don't fit and Screen + face for screen recordings. As you fix framing, it learns your choices."}
              </Text>
              <OutlinedActionButton
                h="30px"
                px={3}
                fontSize="xs"
                disabled={fixing}
                onClick={() => {
                  setFixing(true);
                  void onAutoFixAll()
                    .then((count) => setFixNote(count ? `Auto-fixed ${count} shot${count === 1 ? "" : "s"}. Check framing again to see what's left.` : "Nothing to auto-fix."))
                    .catch((error: unknown) => setFixNote(error instanceof Error ? error.message : String(error)))
                    .finally(() => setFixing(false));
                }}
              >
                {fixing ? "Fixing…" : "Auto-fix all clips"}
              </OutlinedActionButton>
            </HStack>
            {learned.length ? (
              <Box as="button" alignSelf="flex-start" fontSize="xs" color={theme.text.muted} cursor="pointer" onClick={() => (forgetLearnedFraming(), setFixNote("Forgot what it learned."))}>
                Forget what it learned
              </Box>
            ) : null}
            {fixNote ? (
              <Text fontSize="xs" color={theme.text.muted}>
                {fixNote}
              </Text>
            ) : null}
          </VStack>
        ) : null}
        {sorted.map((entry) => (
          <VStack key={entry.clipIndex} align="stretch" gap={2} p={3} borderRadius="lg" border="1px solid" borderColor={theme.surface.hover}>
            <HStack justify="space-between">
              <Text fontSize="sm" fontWeight="semibold">
                Clip {entry.clipIndex + 1}
              </Text>
              {entry.issues?.length ? (
                <OutlinedActionButton h="28px" px={3} fontSize="xs" onClick={() => onFix(entry.clipIndex)}>
                  Fix
                </OutlinedActionButton>
              ) : null}
            </HStack>
            {entry.issues ? (
              <ClipperFramingIssues issues={entry.issues} compact onJump={() => onFix(entry.clipIndex)} />
            ) : (
              <Text fontSize="xs" color={theme.text.muted}>
                Not analysed yet.
              </Text>
            )}
          </VStack>
        ))}
      </VStack>
    </Box>
  );
};
