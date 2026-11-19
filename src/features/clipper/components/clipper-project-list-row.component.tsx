import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  HStack,
  Progress,
  Text,
  VStack,
  useDisclosure,
} from "@chakra-ui/react";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { type Project } from "../../../services/projects.service";
import { colors, useTheme } from "../../../theme";
import { SecondaryMainTitle } from "../../../shared/fonts/secondary-main-title.font";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { EditClipperProjectModal } from "../pages/edit-clipper-project-modal.component";
import { DeleteClipperProjectModal } from "../pages/delete-clipper-project-modal.component";
import { clipperStageLabel } from "../shared/stages.util";
import { getClipperMetadataFromProject } from "../persistence/metadata-autosave.util";
import { formatShortDate } from "../../../shared/utils/time.util";

interface ClipperProjectListRowProps {
  project: Project;
  onUpdated: () => void;
  onDeleted: () => void;
}

export function ClipperProjectListRow({
  project,
  onUpdated,
  onDeleted,
}: ClipperProjectListRowProps) {
  const navigate = useNavigate();
  const { theme, mode } = useTheme();
  const metadata = getClipperMetadataFromProject(project.metadata);
  const stageLabel = clipperStageLabel(metadata.stage);
  const summary = project.clipperPipelineSummary ?? {
    completedSteps: 0,
    totalSteps: 4,
  };
  const progressPercent =
    summary.totalSteps > 0
      ? (summary.completedSteps / summary.totalSteps) * 100
      : 0;

  const {
    open: isEditOpen,
    onOpen: onEditOpen,
    onClose: onEditClose,
  } = useDisclosure();
  const {
    open: isDeleteOpen,
    onOpen: onDeleteOpen,
    onClose: onDeleteClose,
  } = useDisclosure();

  const rowBg = mode === "dark" ? theme.background.card : "gray.50";

  const handleOpen = useCallback(() => {
    navigate(`/clipper/${project.id}`);
  }, [navigate, project.id]);

  return (
    <>
      <Box bg={rowBg} borderRadius="xl" px={{ base: 4, md: 5 }} py={3}>
        <HStack
          justify="space-between"
          gap={4}
          flexWrap={{ base: "wrap", md: "nowrap" }}
        >
          <VStack
            align="start"
            gap={1.5}
            flex="1"
            minW={0}
            cursor="pointer"
            onClick={handleOpen}
            role="link"
            aria-label={`Open ${project.name}`}
          >
            <SecondaryMainTitle
              fontSize="md"
              color={theme.text.primary}
              lineClamp={1}
            >
              {project.name}
            </SecondaryMainTitle>
            <HStack gap={3} flexWrap="wrap">
              <Box
                px={2}
                py={0.5}
                borderRadius="full"
                bg={
                  mode === "dark"
                    ? theme.brand.purpleSoftAlpha12
                    : theme.brand.toggleActiveBg
                }
                color={colors.purple.medium}
                fontSize="xs"
                fontWeight="semibold"
              >
                {stageLabel}
              </Box>
              <Box w="120px">
                <Progress.Root value={progressPercent} size="xs">
                  <Progress.Track
                    bg={
                      mode === "dark"
                        ? theme.surface.active
                        : theme.border.secondary
                    }
                    borderRadius="full"
                  >
                    <Progress.Range
                      bg={colors.purple.medium}
                      borderRadius="full"
                    />
                  </Progress.Track>
                </Progress.Root>
              </Box>
              <Text fontSize="xs" color={theme.text.muted}>
                {summary.completedSteps} of {summary.totalSteps} steps · updated{" "}
                {formatShortDate(project.updatedAt)}
              </Text>
            </HStack>
          </VStack>

          <HStack gap={2} flexShrink={0}>
            <OutlinedActionButton
              h="32px"
              px={4}
              startIcon={<ArrowRight size={15} />}
              onClick={handleOpen}
            >
              Open
            </OutlinedActionButton>
            <OutlinedActionButton
              h="32px"
              px={3}
              startIcon={<Pencil size={14} />}
              onClick={onEditOpen}
              title="Rename or change the project's details"
            >
              Rename
            </OutlinedActionButton>
            <OutlinedActionButton
              h="32px"
              px={2.5}
              onClick={onDeleteOpen}
              title="Delete project"
              aria-label="Delete project"
            >
              <Trash2 size={15} />
            </OutlinedActionButton>
          </HStack>
        </HStack>
      </Box>
      <EditClipperProjectModal
        isOpen={isEditOpen}
        onClose={onEditClose}
        project={project}
        onProjectUpdated={() => {
          onEditClose();
          onUpdated();
        }}
      />

      <DeleteClipperProjectModal
        isOpen={isDeleteOpen}
        onClose={onDeleteClose}
        project={project}
        onProjectDeleted={() => {
          onDeleteClose();
          onDeleted();
        }}
      />
    </>
  );
}
