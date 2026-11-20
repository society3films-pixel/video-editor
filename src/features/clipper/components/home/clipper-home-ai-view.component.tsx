import React from "react";
import { Box, Text, VStack } from "@chakra-ui/react";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { ClipperAiEditorPanel } from "../../editor/ai-editor/clipper-ai-editor-panel.component";

/** Home → AI: set up the AI (local model, Claude, or a cloud key) before opening any project. */
export const ClipperHomeAiView: React.FC = () => {
  const { theme } = useClipperUi();
  return (
    <VStack align="stretch" gap={4} maxW="640px">
      <Box>
        <Text fontSize="2xl" fontWeight="bold" mb={1}>
          AI
        </Text>
        <Text fontSize="sm" color={theme.text.muted}>
          For a free, private setup, run Ollama on this computer and pick <b>Local model</b>. Use a vision model (for
          example qwen2.5vl) when tagging B-roll, and a larger text model for everything else.
        </Text>
      </Box>
      <Box p={4} borderRadius="xl" border="1px solid" borderColor={theme.surface.hover} bg={theme.background.card}>
        <ClipperAiEditorPanel setupOnly />
      </Box>
    </VStack>
  );
};
