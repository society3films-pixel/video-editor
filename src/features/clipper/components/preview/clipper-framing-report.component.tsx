import React from "react";
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
}> = ({ entries, formatLabel, onFix, onClose }) => {
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
