import React, { useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { PenLine } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { ClipperFormatResult } from "../shared/state.util";
import { patchClipperExportSocial } from "../persistence/clipper-export-db-api.util";
import { describeAiChoice, resolveAiChoice } from "../editor/ai-editor/ai-choice.util";
import { needsSocialMetadata, socialPatchFor, writeSocialMetadata } from "../editor/ai-editor/ai-social-metadata.util";

interface ClipperExportsAiToolsProps {
  exports: ClipperFormatResult[];
  onChanged: () => void;
  /** Extra tools rendered in the same bar (batch editing). */
  children?: React.ReactNode;
}

/** AI actions that work across all of a project's exports. */
export const ClipperExportsAiTools: React.FC<ClipperExportsAiToolsProps> = ({ exports, onChanged, children }) => {
  const { theme } = useClipperUi();
  const [overwrite, setOverwrite] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const available = exports.filter((item) => !item.isMissing && (item.transcriptPlain?.trim() || item.transcriptTimestamped?.trim()));
  const targets = overwrite ? available : available.filter(needsSocialMetadata);

  const writeAll = async () => {
    setMessage(null);
    let choice;
    try {
      choice = await resolveAiChoice();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
      return;
    }
    const failures: string[] = [];
    setProgress({ done: 0, total: targets.length });
    for (const [index, item] of targets.entries()) {
      try {
        const draft = await writeSocialMetadata(choice, item);
        const patch = socialPatchFor(item, draft, overwrite);
        if (Object.keys(patch).length) await patchClipperExportSocial(item.id, patch, "overwrite");
      } catch (error) {
        failures.push(`${item.label} clip ${item.clipIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      setProgress({ done: index + 1, total: targets.length });
    }
    setProgress(null);
    onChanged();
    const written = targets.length - failures.length;
    setMessage({
      text: failures.length
        ? `Wrote metadata for ${written} of ${targets.length} with ${describeAiChoice(choice)}. Failed: ${failures.slice(0, 3).join("; ")}`
        : `Wrote titles, descriptions and hashtags for ${written} export${written === 1 ? "" : "s"} with ${describeAiChoice(choice)}.`,
      error: failures.length > 0,
    });
  };

  return (
    <Box p={4} borderRadius="xl" border="1px solid" borderColor={theme.surface.hover} bg={theme.surface.faint}>
      <VStack align="stretch" gap={3}>
        <Text fontSize="sm" fontWeight="semibold">
          AI tools
        </Text>
        <HStack gap={3} flexWrap="wrap">
          <OutlinedActionButton
            startIcon={progress ? <Spinner size="xs" /> : <PenLine size={16} />}
            onClick={() => void writeAll()}
            disabled={Boolean(progress) || targets.length === 0}
            title="Writes a hook title, descriptions and hashtags from each clip's transcript"
          >
            {progress ? `Writing ${progress.done}/${progress.total}…` : "Write titles & hashtags"}
          </OutlinedActionButton>
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} style={{ accentColor: clipperTheme.accent }} />
            Rewrite ones that are already filled
          </label>
          <Text fontSize="xs" color={theme.text.muted}>
            {targets.length === 0
              ? overwrite
                ? "No exports with a transcript."
                : "Every export already has a title, description and hashtags."
              : `${targets.length} export${targets.length === 1 ? "" : "s"} to write.`}
          </Text>
        </HStack>
        {children}
        {message ? (
          <Text fontSize="xs" color={message.error ? theme.status.danger : theme.text.muted}>
            {message.text}
          </Text>
        ) : null}
      </VStack>
    </Box>
  );
};
