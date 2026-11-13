import React, { useEffect, useRef, useState } from "react";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { FolderSearch } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { OutlinedActionButton } from "../../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { useAuth } from "../../../../shared/hooks/use-auth.hook";
import { createClipperProject } from "../../persistence/bootstrap.util";
import {
  listWatchFolderVideos,
  loadJob,
  loadLog,
  loadProcessed,
  loadWatchFolderSettings,
  logEntry,
  markAllProcessed,
  markProcessed,
  readyFiles,
  saveJob,
  saveWatchFolderSettings,
  type WatchFolderSettings,
} from "../../persistence/watch-folder.util";

const POLL_MS = 30_000;

/** Home page: pick a folder; new videos in it are clipped and rendered automatically. */
export const ClipperWatchFolder: React.FC = () => {
  const { theme } = useClipperUi();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<WatchFolderSettings>(loadWatchFolderSettings);
  const [status, setStatus] = useState<string | null>(null);
  const [log] = useState(loadLog);
  const sizesRef = useRef(new Map<string, number>());
  const busyRef = useRef(false);

  const update = (next: WatchFolderSettings) => {
    setSettings(next);
    saveWatchFolderSettings(next);
  };

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Choose a folder to watch" });
    if (typeof picked !== "string") return;
    try {
      // Videos already there are left alone; only new ones are processed.
      markAllProcessed(await listWatchFolderVideos(picked));
      update({ ...settings, dir: picked, enabled: true });
      setStatus("Watching. Drop a video in the folder and leave the app open on this page.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!settings.enabled || !settings.dir) return;
    const dir = settings.dir;
    let cancelled = false;
    const poll = async () => {
      if (busyRef.current || cancelled) return;
      // A job still marked as running means its project page was left; it gets one retry later.
      const job = loadJob();
      if (job && Date.now() - job.startedAt < 6 * 60 * 60 * 1000) {
        navigate(`/clipper/${job.projectId}`);
        return;
      }
      if (job) {
        logEntry({ name: job.name, projectId: job.projectId, status: "failed", at: Date.now(), detail: "Took longer than 6 hours" });
        saveJob(null);
      }
      busyRef.current = true;
      try {
        const files = await listWatchFolderVideos(dir);
        const ready = readyFiles(files, sizesRef.current, new Set(loadProcessed()));
        sizesRef.current = new Map(files.map((file) => [file.path, file.size]));
        const next = ready[0];
        if (!next || cancelled) {
          setStatus(`Watching ${dir}. ${files.length} video${files.length === 1 ? "" : "s"} in the folder, nothing new.`);
          return;
        }
        markProcessed(next);
        const name = next.name.replace(/\.[^.]+$/, "");
        setStatus(`New video: ${next.name}. Creating a project…`);
        const project = await createClipperProject({ name, token: token ?? "" });
        saveJob({ projectId: project.id, path: next.path, name: next.name, autoRender: settings.autoRender, startedAt: Date.now() });
        logEntry({ name: next.name, projectId: project.id, status: "processing", at: Date.now() });
        navigate(`/clipper/${project.id}`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        busyRef.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [navigate, settings.autoRender, settings.dir, settings.enabled, token]);

  return (
    <VStack align="stretch" gap={2} p={4} borderRadius="xl" border="1px solid" borderColor={theme.surface.hover} bg={theme.background.card}>
      <HStack gap={3} flexWrap="wrap">
        <Text fontWeight="semibold" fontSize="sm">
          Watch folder
        </Text>
        <OutlinedActionButton h="30px" px={3} fontSize="xs" startIcon={<FolderSearch size={14} />} onClick={() => void chooseFolder()}>
          {settings.dir ? "Change folder" : "Choose a folder"}
        </OutlinedActionButton>
        {settings.dir ? (
          <>
            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ ...settings, enabled: e.target.checked })} />
              On
            </label>
            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={settings.autoRender} onChange={(e) => update({ ...settings, autoRender: e.target.checked })} />
              Render the clips too
            </label>
          </>
        ) : null}
      </HStack>
      <Text fontSize="xs" color={theme.text.muted}>
        {status ??
          (settings.dir
            ? `${settings.enabled ? "Watching" : "Paused:"} ${settings.dir}`
            : "New videos dropped in the folder become projects that are transcribed, clipped and rendered automatically, one at a time, while the app is open on this page.")}
      </Text>
      {log.length ? (
        <VStack align="stretch" gap={0}>
          {log.slice(0, 5).map((entry) => (
            <Text key={`${entry.projectId}-${entry.at}`} fontSize="xs" color={entry.status === "failed" ? theme.status.danger : theme.text.muted}>
              {entry.status === "done" ? "✓" : entry.status === "failed" ? "✗" : "…"} {entry.name}
              {entry.detail ? `: ${entry.detail}` : ""}
            </Text>
          ))}
        </VStack>
      ) : null}
    </VStack>
  );
};
