import React, { useState } from "react";
import { HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { FolderInput } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { OutlinedActionButton } from "../../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { useAuth } from "../../../../shared/hooks/use-auth.hook";
import { openClipperProjectsDir } from "../../persistence/project-data-files.util";
import {
  runFolderDraft,
  type FolderDraftResult,
} from "../../editor/folder-draft/folder-draft-run.util";

const ROLE_LABEL = {
  talk: "Interview camera",
  performance: "Performance",
  broll: "B-roll",
  recorder: "Sound recorder",
} as const;

function time(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Home → Folder to draft: a shoot folder in, a synced multicam draft timeline out. */
export const ClipperFolderDraft: React.FC = () => {
  const { theme } = useClipperUi();
  const { token } = useAuth();
  const [dir, setDir] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [focus, setFocus] = useState("");
  const [progress, setProgress] = useState<{
    step: string;
    ratio: number;
  } | null>(null);
  const [result, setResult] = useState<FolderDraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose the folder with every file from the shoot",
    });
    if (typeof picked === "string") {
      setDir(picked);
      setResult(null);
      setError(null);
    }
  };

  const build = async () => {
    if (!dir) return;
    setError(null);
    setResult(null);
    setProgress({ step: "Starting", ratio: 0 });
    try {
      setResult(
        await runFolderDraft(dir, {
          targetMinutes: minutes,
          focus,
          token: token ?? "",
          onProgress: (step, ratio) => setProgress({ step, ratio }),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProgress(null);
    }
  };

  const field: React.CSSProperties = {
    background: "rgba(0,0,0,0.35)",
    color: "inherit",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 13,
  };

  return (
    <VStack
      align="stretch"
      gap={2}
      p={4}
      borderRadius="xl"
      border="1px solid"
      borderColor={theme.surface.hover}
      bg={theme.background.card}
    >
      <HStack gap={3} flexWrap="wrap">
        <Text fontWeight="semibold" fontSize="sm">
          Folder → draft
        </Text>
        <OutlinedActionButton
          h="30px"
          px={3}
          fontSize="xs"
          startIcon={<FolderInput size={14} />}
          onClick={() => void choose()}
          disabled={Boolean(progress)}
        >
          {dir ? "Change folder" : "Choose a shoot folder"}
        </OutlinedActionButton>
        {dir ? (
          <Text
            fontSize="xs"
            color={theme.text.muted}
            truncate
            maxW="360px"
            title={dir}
          >
            {dir}
          </Text>
        ) : null}
      </HStack>
      <Text fontSize="xs" color={theme.text.muted}>
        Put every file from a shoot in one folder (interview cameras, a separate
        sound recorder, performance takes, B-roll). The app sorts them, lines
        them up by sound, transcribes the interview, has your AI build a story,
        and writes an editable multicam timeline for Premiere or DaVinci
        Resolve. Runs on this computer.
      </Text>
      {dir ? (
        <HStack gap={3} flexWrap="wrap" fontSize="xs">
          <label>
            About{" "}
            <input
              type="number"
              min={2}
              max={120}
              value={minutes}
              onChange={(e) =>
                setMinutes(
                  Math.max(2, Math.min(120, Number(e.target.value) || 15)),
                )
              }
              style={{ ...field, width: 60 }}
            />{" "}
            min
          </label>
          <input
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="Optional focus, e.g. how the album was made"
            style={{ ...field, flex: 1, minWidth: 220 }}
            aria-label="Focus"
          />
          <OutlinedActionButton
            h="30px"
            px={3}
            fontSize="xs"
            onClick={() => void build()}
            disabled={Boolean(progress)}
          >
            {progress ? <Spinner size="xs" /> : null} Build the draft
          </OutlinedActionButton>
        </HStack>
      ) : null}
      {progress ? (
        <Text fontSize="xs" color={theme.text.muted}>
          {Math.round(progress.ratio * 100)}% · {progress.step}…
        </Text>
      ) : null}
      {error ? (
        <Text fontSize="xs" color={theme.status.danger}>
          {error}
        </Text>
      ) : null}
      {result ? (
        <VStack
          align="stretch"
          gap={2}
          p={3}
          borderRadius="md"
          bg="rgba(0,0,0,0.2)"
        >
          <Text fontSize="sm" fontWeight="semibold">
            Draft ready: {time(result.timeline.durationSec)},{" "}
            {result.story.parts.length} parts ({result.ai})
          </Text>
          <Text fontSize="xs" color={theme.text.muted}>
            Saved {result.files.join(" and ")} in {result.folder}. Premiere:
            File → Import the .xml. DaVinci Resolve: File → Import → Timeline.
            The .srt is the talking, for captions.
          </Text>
          <OutlinedActionButton
            h="28px"
            px={2}
            fontSize="xs"
            alignSelf="flex-start"
            onClick={() => void openClipperProjectsDir()}
          >
            Open the project folders
          </OutlinedActionButton>
          <Text fontSize="xs" fontWeight="semibold" mt={1}>
            Files
          </Text>
          {result.items.map((item) => (
            <Text
              key={item.path}
              fontSize="xs"
              color={
                item.offsetSec === null && item.role !== "broll"
                  ? theme.status.warning
                  : theme.text.muted
              }
            >
              {item === result.master ? "★ " : ""}
              {item.name}: {ROLE_LABEL[item.role]}, {time(item.durationSec)}
              {item === result.master
                ? " (master sound)"
                : item.offsetSec !== null
                  ? `, lined up at ${time(item.offsetSec)} (${Math.round(item.syncScore * 100)}% match)`
                  : item.role === "broll"
                    ? ""
                    : ", couldn't be lined up"}
            </Text>
          ))}
          <Text fontSize="xs" fontWeight="semibold" mt={1}>
            Story
          </Text>
          {result.story.parts.map((part, index) => (
            <Text key={index} fontSize="xs" color={theme.text.muted}>
              {index + 1}. {part.kind === "talk" ? "💬" : "♪"} {part.title} (
              {time(part.endSec - part.startSec)})
            </Text>
          ))}
        </VStack>
      ) : null}
    </VStack>
  );
};
