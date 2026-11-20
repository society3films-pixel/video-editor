import React from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { formatEditorTime } from "./clip-edit.util";
import { FRAMING_ISSUE_LABEL, type FramingIssue } from "./framing-check.util";

/** List of likely framing problems; clicking one jumps to it. */
export const ClipperFramingIssues: React.FC<{
  issues: FramingIssue[] | null;
  onJump: (localTime: number) => void;
  compact?: boolean;
}> = ({ issues, onJump, compact }) => {
  const { theme } = useClipperUi();
  if (!issues) return null;
  if (issues.length === 0) {
    return (
      <HStack gap={2} fontSize="xs" color={theme.text.muted}>
        <CheckCircle2 size={14} color={theme.status.success} />
        <Text>No framing problems found.</Text>
      </HStack>
    );
  }
  return (
    <VStack align="stretch" gap={1}>
      {issues.map((issue, index) => (
        <Box
          key={`${issue.kind}-${issue.shotIndex}-${index}`}
          as="button"
          textAlign="left"
          p={2}
          borderRadius="md"
          bg="rgba(0,0,0,0.2)"
          cursor="pointer"
          _hover={{ bg: "rgba(255,255,255,0.06)" }}
          onClick={() => onJump(issue.at)}
          title="Jump to this shot"
        >
          <HStack gap={2} align="start">
            {issue.severity === "warning" ? <AlertTriangle size={14} color={theme.status.warning} /> : <Info size={14} color={theme.text.muted} />}
            <VStack align="stretch" gap={0} flex={1}>
              <Text fontSize="xs" fontWeight="semibold">
                {FRAMING_ISSUE_LABEL[issue.kind]} · shot {issue.shotIndex + 1} ({formatEditorTime(issue.start)}–{formatEditorTime(issue.end)})
              </Text>
              {compact ? null : (
                <Text fontSize="xs" color={theme.text.muted}>
                  {issue.message}
                </Text>
              )}
            </VStack>
          </HStack>
        </Box>
      ))}
    </VStack>
  );
};
