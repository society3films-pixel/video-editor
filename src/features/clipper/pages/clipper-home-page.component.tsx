import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Box,
  Center,
  Flex,
  HStack,
  Text,
  VStack,
  useDisclosure,
} from "@chakra-ui/react";
import { Clapperboard, Eye, FolderOpen, Plus } from "lucide-react";
import { appToast } from "../../../shared/utils/toast.service";
import { AppLoader } from "../../../shared/components/app-loader.component";
import {
  projectsService,
  type Project,
} from "../../../services/projects.service";
import {
  ClipperLayout,
  type ClipperLayoutBackLink,
} from "../components/clipper-layout.component";
import { ClipperProjectListRow } from "../components/clipper-project-list-row.component";
import {
  ClipperHomeNavToggle,
  HOME_AREA_OF,
  HOME_SUBTABS,
  type ClipperHomeTab,
} from "../components/clipper-home-nav-toggle.component";
import { ClipperIntegrationsView } from "../components/clipper-integrations-view.component";
import { ClipperHomeSettingsView } from "../components/clipper-home-settings-view.component";
import { ClipperHomeMcpView } from "../components/clipper-home-mcp-view.component";
import { ClipperPublishView } from "../components/clipper-publish-view.component";
import { ClipperOwnersView } from "../components/clipper-owners-view.component";
import { CreateClipperProjectModal } from "./create-clipper-project-modal.component";
import { ClipperTauriGate } from "./clipper-tauri-gate.component";
import { ClipperHomeAiView } from "../components/home/clipper-home-ai-view.component";
import { ClipperFolderDraft } from "../components/home/clipper-folder-draft.component";
import { ClipperWatchFolder } from "../components/home/clipper-watch-folder.component";
import { isTauri } from "../../../shared/utils/platform.util";
import { ClipperTranscriptSearch } from "../components/home/clipper-transcript-search.component";
import { ClipperFirstRunSetup } from "../components/clipper-first-run-setup.component";
import { openClipperProjectsDir } from "../persistence/project-data-files.util";
import { ProjectsPagination } from "../components/projects-pagination.component";
import { useClipperSetupReadiness } from "../hooks/use-clipper-setup-readiness.hook";
import { useTheme } from "../../../theme";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { SecondaryMainTitle } from "../../../shared/fonts/secondary-main-title.font";

const ITEMS_PER_PAGE = 10;

function StartCard(props: {
  title: string;
  text: string;
  action: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <VStack
      align="stretch"
      justify="space-between"
      gap={3}
      p={4}
      flex="1 1 240px"
      maxW={{ base: "full", md: "360px" }}
      borderRadius="xl"
      border="1px solid"
      borderColor={props.active ? theme.text.primary : theme.dashboard.border}
      bg={theme.background.card}
    >
      <VStack align="start" gap={1}>
        <Text fontWeight="semibold" color={theme.text.primary}>
          {props.title}
        </Text>
        <Text fontSize="sm" color={theme.text.muted}>
          {props.text}
        </Text>
      </VStack>
      <OutlinedActionButton
        width="100%"
        justifyContent="center"
        startIcon={props.icon}
        onClick={props.onClick}
        disabled={props.disabled}
      >
        {props.action}
      </OutlinedActionButton>
    </VStack>
  );
}

export function ClipperHomePage() {
  const { theme } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<ClipperHomeTab>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);
  const {
    open: isCreateOpen,
    onOpen: onCreateOpen,
    onClose: onCreateClose,
  } = useDisclosure();
  const [ownersBackLink, setOwnersBackLink] =
    useState<ClipperLayoutBackLink | null>(null);
  const setup = useClipperSetupReadiness();
  const canCreateProject = projects.length > 0 || setup.setupReady;
  const refreshSetup = setup.refresh;
  const previousTabRef = useRef(activeTab);
  const [startPanel, setStartPanel] = useState<"draft" | "watch" | null>(() => {
    try {
      const saved = localStorage.getItem("openclipper.home.startPanel");
      return saved === "draft" || saved === "watch" ? saved : null;
    } catch {
      return null;
    }
  });
  const toggleStartPanel = (panel: "draft" | "watch") => {
    const next = startPanel === panel ? null : panel;
    setStartPanel(next);
    try {
      localStorage.setItem("openclipper.home.startPanel", next ?? "");
    } catch {
      // Not remembered; fine.
    }
  };

  useEffect(() => {
    if (activeTab !== "owners") {
      setOwnersBackLink(null);
    }
  }, [activeTab]);

  useEffect(() => {
    const previousTab = previousTabRef.current;
    previousTabRef.current = activeTab;
    if (activeTab === "projects" && previousTab !== "projects")
      void refreshSetup();
  }, [activeTab, refreshSetup]);

  useEffect(() => {
    const requested = searchParams.get("tab");
    if (
      requested !== "integrations" &&
      requested !== "settings" &&
      requested !== "ai" &&
      requested !== "mcp" &&
      requested !== "publish" &&
      requested !== "owners"
    ) {
      return;
    }
    setActiveTab(requested);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("tab");
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const response = await projectsService.getAll(
        currentPage,
        ITEMS_PER_PAGE,
        "",
        "clipper",
        "updatedAt",
      );
      setProjects(response.data);
      setTotal(response.total);
    } catch (error) {
    } finally {
      setLoading(false);
    }
  }, [currentPage]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleProjectDeleted = useCallback(async () => {
    if (projects.length === 1 && currentPage > 1) {
      setCurrentPage((page) => page - 1);
      return;
    }
    await loadProjects();
  }, [projects.length, currentPage, loadProjects]);

  const handleOpenProjectsDir = useCallback(async () => {
    try {
      await openClipperProjectsDir();
    } catch (error) {
      appToast.error("Error", "Could not open the project data folder.");
    }
  }, []);

  return (
    <ClipperTauriGate>
      <ClipperLayout
        headerStartExtra={
          ownersBackLink ? undefined : (
            <ClipperHomeNavToggle value={activeTab} onChange={setActiveTab} />
          )
        }
        backLink={ownersBackLink ?? undefined}
      >
        {HOME_SUBTABS[HOME_AREA_OF[activeTab]].length && !ownersBackLink ? (
          <HStack gap={1} mb={4} flexWrap="wrap">
            {HOME_SUBTABS[HOME_AREA_OF[activeTab]].map((sub) => (
              <Box
                key={sub.value}
                as="button"
                px={3}
                py={1}
                fontSize="sm"
                fontWeight="semibold"
                borderBottom="2px solid"
                borderColor={
                  activeTab === sub.value ? theme.text.primary : "transparent"
                }
                color={
                  activeTab === sub.value
                    ? theme.text.primary
                    : theme.text.muted
                }
                cursor="pointer"
                onClick={() => setActiveTab(sub.value)}
              >
                {sub.label}
              </Box>
            ))}
          </HStack>
        ) : null}
        {activeTab === "integrations" ? (
          <ClipperIntegrationsView />
        ) : activeTab === "ai" ? (
          <ClipperHomeAiView />
        ) : activeTab === "settings" ? (
          <ClipperHomeSettingsView />
        ) : activeTab === "mcp" ? (
          <ClipperHomeMcpView />
        ) : activeTab === "publish" ? (
          <ClipperPublishView />
        ) : activeTab === "owners" ? (
          <ClipperOwnersView
            onOpenIntegrations={() => setActiveTab("integrations")}
            onHeaderBackChange={setOwnersBackLink}
          />
        ) : (
          <VStack align="stretch" gap={6} flex="1" minH={0}>
            <HStack
              justify="space-between"
              align="end"
              flexWrap="wrap"
              gap={4}
              flexShrink={0}
            >
              <VStack align="start" gap={1} maxW="640px">
                <SecondaryMainTitle
                  fontSize={{ base: "2xl", md: "3xl" }}
                  fontWeight="bold"
                  color={theme.text.primary}
                >
                  What are you making?
                </SecondaryMainTitle>
                <Text color={theme.text.muted}>
                  Shorts from one video (the app finds the clips, frames and
                  captions them; you can edit every one afterwards), or a
                  long-form draft from a whole shoot.
                </Text>
              </VStack>
              <OutlinedActionButton
                h="30px"
                px={3}
                fontSize="xs"
                startIcon={<FolderOpen size={14} />}
                onClick={() => void handleOpenProjectsDir()}
              >
                Project data folder
              </OutlinedActionButton>
            </HStack>

            <Flex gap={3} flexWrap="wrap" flexShrink={0}>
              <StartCard
                title="Shorts from a video"
                text="Pick a video: clips are found, reframed and captioned. Then Edit clip in Preview for full control."
                action="New shorts project"
                icon={<Plus size={16} />}
                onClick={onCreateOpen}
                disabled={!canCreateProject}
              />
              {isTauri() ? (
                <StartCard
                  title="Long-form draft from a shoot"
                  text="A folder of cameras, recorder and B-roll: synced, transcribed and cut into a story for Premiere or Resolve."
                  action={startPanel === "draft" ? "Hide" : "Open"}
                  icon={<Clapperboard size={16} />}
                  active={startPanel === "draft"}
                  onClick={() => toggleStartPanel("draft")}
                />
              ) : null}
              {isTauri() ? (
                <StartCard
                  title="Watch a folder"
                  text="New videos dropped in a folder become projects automatically, clipped and rendered."
                  action={startPanel === "watch" ? "Hide" : "Set up"}
                  icon={<Eye size={16} />}
                  active={startPanel === "watch"}
                  onClick={() => toggleStartPanel("watch")}
                />
              ) : null}
            </Flex>

            {isTauri() && startPanel === "draft" ? (
              <ClipperFolderDraft />
            ) : null}
            {isTauri() && startPanel === "watch" ? (
              <ClipperWatchFolder />
            ) : null}
            {projects.length > 0 ? (
              <Text
                fontSize="sm"
                fontWeight="semibold"
                color={theme.text.primary}
                mt={2}
              >
                Your projects
              </Text>
            ) : null}
            {projects.length > 0 ? <ClipperTranscriptSearch /> : null}

            {loading || (projects.length === 0 && !setup.loaded) ? (
              <Center py={16} flex="1">
                <AppLoader />
              </Center>
            ) : projects.length === 0 && !setup.setupReady ? (
              <ClipperFirstRunSetup readiness={setup} />
            ) : projects.length === 0 ? (
              <Box
                p={10}
                borderRadius="2xl"
                border="1px dashed"
                borderColor={theme.dashboard.border}
                textAlign="center"
                bg={theme.background.card}
                flex="1"
                display="flex"
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
              >
                <Text color={theme.text.primary} fontWeight="semibold" mb={2}>
                  No Clipper projects yet
                </Text>
                <Text color={theme.text.muted} mb={5}>
                  Start by choosing where your source video will be stored, then
                  upload and clip.
                </Text>
                <OutlinedActionButton
                  width="100%"
                  maxW="320px"
                  justifyContent="center"
                  startIcon={<Plus size={16} />}
                  onClick={onCreateOpen}
                >
                  Create your first clip project
                </OutlinedActionButton>
              </Box>
            ) : (
              <VStack align="stretch" gap={3}>
                {projects.map((project) => (
                  <ClipperProjectListRow
                    key={project.id}
                    project={project}
                    onUpdated={() => void loadProjects()}
                    onDeleted={() => void handleProjectDeleted()}
                  />
                ))}

                <ProjectsPagination
                  currentPage={currentPage}
                  totalItems={total}
                  itemsPerPage={ITEMS_PER_PAGE}
                  onPageChange={setCurrentPage}
                />
              </VStack>
            )}
          </VStack>
        )}

        <CreateClipperProjectModal
          isOpen={isCreateOpen}
          onClose={onCreateClose}
          onCreated={() => {
            setCurrentPage(1);
            void loadProjects();
          }}
        />
      </ClipperLayout>
    </ClipperTauriGate>
  );
}
