import React, { useState } from "react";
import { Box, Flex, HStack, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { ClipperVideoEditor } from "../editor/clipper-video-editor.component";
import type { ClipEditorSource } from "../editor/clip-editor-source.util";
import {
  CLIPPER_FORMAT_DEFS,
  getBadgePlatformsForFormat,
  getClipperCardFrameSize,
} from "../shared/formats.util";
import { resolveClipperExportFileName } from "../persistence/resolve-export-upload-file.util";
import { formatBytes } from "../shared/logger.util";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import type { ClipperFormatResult } from "../shared/state.util";
import { ClipperPlatformIcon } from "./clipper-platform-icon.component";
import { ClipperExportRevealButton } from "./clipper-export-reveal-button.component";
import { ClipperExportPlayer } from "./clipper-export-player.component";

const THUMB_HEIGHT = 144;
const PLATFORM_ICON_SIZE = 28;
const PREVIEW_COLUMN_WIDTH = Math.max(
  ...CLIPPER_FORMAT_DEFS.map((def) => getClipperCardFrameSize(def.id, THUMB_HEIGHT).width),
);
const ACTIONS_COLUMN_WIDTH = 180;

interface ClipperExportFormatRowProps {
  result: ClipperFormatResult;
  projectId: string;
  /** Called after an edited copy of this export is saved. */
  onEdited?: () => void;
  getClipEditorSource?: (result: ClipperFormatResult) => ClipEditorSource | null;
}

function formatExportedAt(exportedAt: string): string {
  const date = new Date(exportedAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export const ClipperExportFormatRow: React.FC<ClipperExportFormatRowProps> = ({
  result,
  projectId,
  onEdited,
  getClipEditorSource,
}) => {
  const { theme } = useClipperUi();
  const [editorSource, setEditorSource] = useState<ClipEditorSource | null | undefined>(undefined);
  const editorOpen = editorSource !== undefined;
  const frame = getClipperCardFrameSize(result.formatId, THUMB_HEIGHT);
  const isMissing = result.isMissing === true;
  const exportedAtLabel = formatExportedAt(result.exportedAt);
  const clipLabel = `Clip ${result.clipIndex + 1}`;
  const badgePlatforms = getBadgePlatformsForFormat(result.formatId);

  return (
    <HStack
      align="center"
      gap={4}
      p={4}
      borderRadius="xl"
      border="1px solid"
      borderColor={theme.surface.hover}
      bg={theme.surface.faint}
      flexWrap={{ base: "wrap", lg: "nowrap" }}
    >
      <Flex
        flexShrink={0}
        w={{ base: "full", lg: `${PREVIEW_COLUMN_WIDTH}px` }}
        minW={{ lg: `${PREVIEW_COLUMN_WIDTH}px` }}
        justify="center"
        align="center"
      >
        <Box
          w={`${frame.width}px`}
          h={`${frame.height}px`}
          borderRadius="lg"
          overflow="hidden"
          bg={theme.background.surface}
          border="1px solid"
          borderColor={theme.surface.hover}
          position="relative"
        >
          {isMissing ? (
            <Flex
              direction="column"
              align="center"
              justify="center"
              w="full"
              h="full"
              gap={2}
              px={3}
              color={theme.text.muted}
            >
              <AlertTriangle size={24} />
              <Text fontSize="xs" fontWeight="semibold" textAlign="center">
                Lost media
              </Text>
            </Flex>
          ) : (
            <ClipperExportPlayer
              src={result.previewUrl}
              width={frame.width}
              height={frame.height}
              title={result.label}
            />
          )}
        </Box>
      </Flex>

      <VStack align="stretch" gap={0} flex={1} minW={0}>
        <HStack align="center" gap={2} w="full">
          <Flex
            minW={`${PLATFORM_ICON_SIZE}px`}
            h={`${PLATFORM_ICON_SIZE}px`}
            align="center"
            justify="center"
            flexShrink={0}
            position="relative"
          >
            {badgePlatforms.length > 1 ? (
              <HStack gap={1}>
                {badgePlatforms.map((platform) => (
                  <ClipperPlatformIcon key={platform} platform={platform} size={PLATFORM_ICON_SIZE} />
                ))}
              </HStack>
            ) : (
              <ClipperPlatformIcon
                platform={badgePlatforms[0] ?? result.platform}
                size={PLATFORM_ICON_SIZE}
              />
            )}
          </Flex>
          <VStack align="start" gap={1} flex={1} minW={0}>
            <Text fontSize="sm" fontWeight="semibold" color={theme.text.primary} lineClamp={1}>
              {result.label}
            </Text>
            <Text fontSize="xs" color={theme.text.muted}>
              {clipLabel}
              {isMissing ? " · Lost media" : ""}
              {" · "}
              {result.width}×{result.height} · {formatBytes(result.fileSize)}
            </Text>
            {exportedAtLabel ? (
              <Text fontSize="xs" color={theme.text.muted}>
                Exported {exportedAtLabel}
              </Text>
            ) : null}
            {result.registrationPending ? (
              <Text fontSize="xs" color={theme.status.danger}>
                Video saved. Export record pending; retry saving before closing.
              </Text>
            ) : null}
          </VStack>
        </HStack>
      </VStack>

      <VStack
        align="stretch"
        gap={2}
        flexShrink={0}
        w={{ base: "full", lg: `${ACTIONS_COLUMN_WIDTH}px` }}
        minW={{ lg: `${ACTIONS_COLUMN_WIDTH}px` }}
      >
        <OutlinedActionButton
          width="100%"
          justifyContent="center"
          whiteSpace="nowrap"
          startIcon={<Clapperboard size={16} />}
          onClick={() => setEditorSource(getClipEditorSource?.(result) ?? null)}
          disabled={isMissing || result.registrationPending === true}
        >
          Edit video
        </OutlinedActionButton>
        <ClipperExportRevealButton
          projectId={projectId}
          fileName={resolveClipperExportFileName(result)}
          disabled={isMissing}
        />
      </VStack>
      {editorOpen ? (
        <ClipperVideoEditor
          result={result}
          projectId={projectId}
          source={editorSource}
          onClose={() => setEditorSource(undefined)}
          onSaved={() => onEdited?.()}
        />
      ) : null}
    </HStack>
  );
};
