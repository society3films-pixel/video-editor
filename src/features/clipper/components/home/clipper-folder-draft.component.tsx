import React, { useEffect, useRef, useState } from "react";
import { Button, Grid, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { clipperTheme } from "../../shared/theme.util";
import { ArrowDown, ArrowUp, FolderInput, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { OutlinedActionButton } from "../../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { useAuth } from "../../../../shared/hooks/use-auth.hook";
import {
  openClipperExportsDir,
  revealClipperExportInFolder,
} from "../../persistence/export-files-open.util";
import {
  camerasForPart,
  cutStoryPart,
  trimStoryPart,
  type FolderMedia,
} from "../../editor/folder-draft/folder-draft.util";
import { refineOffset } from "../../editor/folder-draft/folder-draft-sync.util";
import {
  listenPoint,
  playSyncListen,
  stopSyncListen,
} from "../../editor/folder-draft/folder-draft-listen.util";
import { analyzeDraftSpeakers } from "../../editor/folder-draft/folder-draft-speaker.util";
import { isTauri } from "../../../../shared/utils/platform.util";
import {
  draftMaster,
  draftTimeline,
  exportFolderDraft,
  loadLastFolderDraft,
  renderFolderDraft,
  runFolderDraft,
  saveFolderDraft,
  type FolderDraft,
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

function syncDetail(item: FolderMedia): string {
  const bits: string[] = [];
  if (item.sync?.method === "timecode") bits.push("by timecode");
  else if (item.sync?.method === "manual") bits.push("set by hand");
  else if (item.sync)
    bits.push(`${item.sync.agreed} of ${item.sync.tried} checks agree`);
  else bits.push(`${Math.round(item.syncScore * 100)}% match`);
  if (item.drift && Math.abs(item.drift) > 2e-6)
    bits.push(`drift ${(item.drift * 1e6).toFixed(0)} ppm`);
  if (item.sync?.refined) bits.push("fine-tuned");
  return ` (${bits.join(", ")})`;
}

/** "m:ss", "h:mm:ss" or seconds → seconds. */
function parseTime(text: string): number | null {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const parts = trimmed.replace(/^-/, "").split(":").map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  const sec = parts.reduce((total, p) => total * 60 + p, 0);
  return negative ? -sec : sec;
}

const nudgeButton: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  color: "inherit",
  cursor: "pointer",
  padding: "0 5px",
  fontSize: 11,
};

const field: React.CSSProperties = {
  background: "rgba(0,0,0,0.35)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 13,
};

const iconButton: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: 2,
  opacity: 0.75,
};

/** Home → Folder to draft: a shoot folder in, a synced multicam draft out (timeline or MP4). */
export const ClipperFolderDraft: React.FC = () => {
  const { theme } = useClipperUi();
  const { token } = useAuth();
  const [dir, setDir] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<{ step: string; ratio: number } | null>(
    null,
  );
  const [draft, setDraft] = useState<FolderDraft | null>(null);
  const [written, setWritten] = useState<{
    files: string[];
    folder: string;
    stale: boolean;
  } | null>(null);
  const [rendered, setRendered] = useState<{
    path: string;
    via: string;
  } | null>(null);
  const [captions, setCaptions] = useState(true);
  const [maxHeight, setMaxHeight] = useState(1080);
  const [openPart, setOpenPart] = useState<number | null>(null);
  const [selection, setSelection] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void loadLastFolderDraft().then((last) => {
      if (last) setDraft((current) => current ?? last);
    });
  }, []);

  const choose = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose the folder with every file from the shoot",
    });
    if (typeof picked === "string") {
      setDir(picked);
      setError(null);
    }
  };

  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    setError(null);
    abort.current = new AbortController();
    setBusy({ step: "Starting", ratio: 0 });
    try {
      await task(abort.current.signal);
    } catch (reason) {
      if (!abort.current.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
      abort.current = null;
    }
  };

  const build = () =>
    run(async (signal) => {
      if (!dir) return;
      const result = await runFolderDraft(dir, {
        targetMinutes: minutes,
        focus,
        token: token ?? "",
        signal,
        onProgress: (step, ratio) => setBusy({ step, ratio }),
      });
      setDraft(result.draft);
      setWritten({ files: result.files, folder: result.folder, stale: false });
      setRendered(null);
    });

  const change = (next: FolderDraft) => {
    setDraft(next);
    setWritten((w) => (w ? { ...w, stale: true } : w));
    void saveFolderDraft(next);
  };

  const exportFiles = () =>
    run(async () => {
      if (!draft) return;
      setBusy({ step: "Writing the timeline", ratio: 0.5 });
      const result = await exportFolderDraft(draft);
      setWritten({ files: result.files, folder: result.folder, stale: false });
    });

  const render = () =>
    run(async (signal) => {
      if (!draft) return;
      const result = await renderFolderDraft(draft, {
        captions,
        maxHeight: maxHeight || undefined,
        signal,
        onProgress: (ratio) => setBusy({ step: "Rendering the MP4", ratio }),
      });
      setRendered(result);
    });

  const timeline = draft ? draftTimeline(draft) : null;
  const master = draft ? draftMaster(draft) : null;
  const parts = draft?.story.parts ?? [];
  const move = (index: number, by: number) => {
    if (!draft) return;
    const next = [...parts];
    const [part] = next.splice(index, 1);
    next.splice(index + by, 0, part!);
    // Hand-picked cameras follow their part.
    const cameraFor: Record<number, string> = {};
    for (const [k, v] of Object.entries(draft.cameraFor)) {
      const i = Number(k);
      const j = i === index ? index + by : i === index + by ? index : i;
      cameraFor[j] = v;
    }
    change({ ...draft, story: { ...draft.story, parts: next }, cameraFor });
  };
  const remove = (index: number) => {
    if (!draft) return;
    const cameraFor: Record<number, string> = {};
    for (const [k, v] of Object.entries(draft.cameraFor)) {
      const i = Number(k);
      if (i !== index) cameraFor[i > index ? i - 1 : i] = v;
    }
    change({
      ...draft,
      story: { ...draft.story, parts: parts.filter((_, i) => i !== index) },
      cameraFor,
    });
  };
  const setItem = (path: string, patch: Partial<FolderMedia>) => {
    if (!draft) return;
    change({
      ...draft,
      items: draft.items.map((m) => (m.path === path ? { ...m, ...patch } : m)),
      activity: undefined,
    });
  };
  const nudge = (path: string, by: number) => {
    const item = draft?.items.find((m) => m.path === path);
    if (item?.offsetSec == null) return;
    setItem(path, {
      offsetSec: item.offsetSec + by,
      sync: {
        ...(item.sync ?? { agreed: 0, tried: 0, refined: false }),
        method: "manual",
        refined: false,
      },
    });
  };
  const [listening, setListening] = useState<string | null>(null);
  const listen = async (path: string) => {
    if (listening) {
      stopSyncListen();
      if (listening === path) return;
    }
    if (!draft) return;
    const item = draft.items.find((m) => m.path === path);
    const masterItem = draftMaster(draft);
    const reference =
      item &&
      item !== masterItem &&
      masterItem.hasAudio &&
      listenPoint(item, masterItem) !== null
        ? masterItem
        : draft.items.find(
            (m) =>
              m !== item && m.hasAudio && item && listenPoint(item, m) !== null,
          );
    if (!item || !reference) {
      setError(
        `${item?.name ?? "This file"} doesn't overlap another recording long enough to compare.`,
      );
      return;
    }
    // A talking part inside the overlap when there is one, else the overlap's middle.
    const overlapStart = Math.max(item.offsetSec!, reference.offsetSec!);
    const overlapEnd = 2 * listenPoint(item, reference)! - overlapStart;
    const part = draft.story.parts.find(
      (p) =>
        p.kind === "talk" &&
        p.endSec - p.startSec > 7 &&
        p.startSec >= overlapStart &&
        p.endSec <= overlapEnd,
    );
    setListening(path);
    setError(null);
    try {
      await playSyncListen(
        item,
        reference,
        part ? part.startSec + 0.5 : listenPoint(item, reference)!,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setListening((current) => (current === path ? null : current));
    }
  };
  const fineTune = (path: string) =>
    run(async () => {
      if (!draft) return;
      const item = draft.items.find((m) => m.path === path);
      const ref = draftMaster(draft);
      if (!item || !ref) return;
      setBusy({ step: `Fine-tuning ${item.name}`, ratio: 0.5 });
      const others = [
        ref,
        ...draft.items.filter(
          (m) => m !== item && m !== ref && m.offsetSec !== null && m.hasAudio,
        ),
      ];
      for (const reference of others) {
        const refined = await refineOffset(item, reference, {
          searchSec: 1.5,
          places: 4,
        });
        if (refined) {
          setItem(path, {
            offsetSec: refined.offsetSec,
            sync: {
              ...(item.sync ?? { method: "manual", agreed: 0, tried: 0 }),
              refined: true,
            },
          });
          return;
        }
      }
      throw new Error(
        `Couldn't find ${item.name}'s sound near there. Nudge it closer (within a second) and try again.`,
      );
    });
  const followSpeakers = () =>
    run(async (signal) => {
      if (!draft) return;
      const activity = await analyzeDraftSpeakers(draft, {
        signal,
        onProgress: (step, ratio) => setBusy({ step, ratio }),
      });
      change({ ...draft, activity });
    });
  /** Word-level edits of a talking part: keep or cut the selected words. */
  const editWords = (index: number, mode: "keep" | "cut") => {
    if (!draft || !selection) return;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    if (mode === "keep") {
      change({
        ...draft,
        story: trimStoryPart(draft.story, index, from, to, draft.words),
      });
    } else {
      const { story, replacedBy } = cutStoryPart(
        draft.story,
        index,
        from,
        to,
        draft.words,
      );
      const cameraFor: Record<number, string> = {};
      for (const [k, v] of Object.entries(draft.cameraFor)) {
        const i = Number(k);
        if (i < index) cameraFor[i] = v;
        else if (i === index)
          for (let j = 0; j < replacedBy; j++) cameraFor[index + j] = v;
        else cameraFor[i + replacedBy - 1] = v;
      }
      change({ ...draft, story, cameraFor });
      if (!replacedBy) setOpenPart(null);
    }
    setSelection(null);
  };
  const pickCamera = (index: number, path: string) => {
    if (!draft) return;
    const cameraFor = { ...draft.cameraFor };
    if (path) cameraFor[index] = path;
    else delete cameraFor[index];
    change({ ...draft, cameraFor });
  };

  const syncState = (
    item: FolderMedia,
  ): { label: string; tone: "ok" | "check" | "off" | "none" } => {
    if (item === master) return { label: "Master sound", tone: "ok" };
    if (item.offsetSec === null) {
      if (item.role === "broll")
        return { label: "Cutaway (not lined up)", tone: "none" };
      if (item.role === "performance")
        return { label: "Separate take, placed whole", tone: "none" };
      return { label: "Couldn't be lined up", tone: "off" };
    }
    const weak =
      item.sync?.method === "sound" &&
      item.sync.tried >= 3 &&
      item.sync.agreed <= 1;
    const at = `${item.offsetSec < 0 ? "−" : ""}${time(Math.abs(item.offsetSec))}`;
    return {
      label: `At ${at}${syncDetail(item)}`,
      tone: weak ? "check" : "ok",
    };
  };
  const toneColor = {
    ok: theme.text.muted,
    check: theme.status.warning,
    off: theme.status.warning,
    none: theme.text.muted,
  } as const;

  return (
    <VStack
      align="stretch"
      gap={3}
      p={4}
      borderRadius="xl"
      border="1px solid"
      borderColor={theme.surface.hover}
      bg={theme.background.card}
    >
      <Text fontSize="xs" color={theme.text.muted}>
        Choose the folder with every file from the shoot (subfolders are
        searched too). Everything runs on this computer.
      </Text>
      <HStack gap={3} flexWrap="wrap">
        <OutlinedActionButton
          h="32px"
          px={3}
          fontSize="sm"
          startIcon={<FolderInput size={15} />}
          onClick={() => void choose()}
          disabled={Boolean(busy)}
        >
          {dir ? "Change folder" : "Choose a shoot folder"}
        </OutlinedActionButton>
        {dir ? (
          <Text
            fontSize="xs"
            color={theme.text.muted}
            truncate
            maxW="480px"
            title={dir}
          >
            {dir}
          </Text>
        ) : null}
      </HStack>
      {dir ? (
        <HStack gap={3} flexWrap="wrap" fontSize="sm">
          <label>
            Length about{" "}
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
            style={{ ...field, flex: 1, minWidth: 240 }}
            aria-label="Focus"
          />
          <Button
            size="sm"
            bg={clipperTheme.accent}
            color="white"
            _hover={{ bg: clipperTheme.accentHover }}
            onClick={() => void build()}
            disabled={Boolean(busy)}
          >
            {draft ? "Build a new draft" : "Build the draft"}
          </Button>
        </HStack>
      ) : null}
      {busy ? (
        <HStack gap={2} fontSize="xs" color={theme.text.muted}>
          <Spinner size="xs" />
          <Text>
            {Math.round(busy.ratio * 100)}% · {busy.step}…
          </Text>
          <OutlinedActionButton
            h="24px"
            px={2}
            fontSize="xs"
            onClick={() => abort.current?.abort()}
          >
            Stop
          </OutlinedActionButton>
        </HStack>
      ) : null}
      {error ? (
        <Text fontSize="xs" color={theme.status.danger}>
          {error}
        </Text>
      ) : null}

      {draft && timeline && master ? (
        <VStack align="stretch" gap={3}>
          <HStack gap={2} flexWrap="wrap" pt={1}>
            <Text fontWeight="semibold">{draft.name}</Text>
            <Text fontSize="sm" color={theme.text.muted}>
              {time(timeline.durationSec)} · {parts.length} part
              {parts.length === 1 ? "" : "s"} · story by {draft.ai}
            </Text>
          </HStack>

          <StepCard
            number={1}
            title="Files and sync"
            hint="Check every file is lined up. Listen with headphones (recorder left, file right); nudge by a frame or a second, then Fine-tune locks it to the sound nearby."
          >
            {draft.items.map((item) => {
              const synced = item.offsetSec !== null && item !== master;
              const frame = 1 / (item.fps || 25);
              const state = syncState(item);
              return (
                <HStack
                  key={item.path}
                  gap={3}
                  fontSize="xs"
                  py={1}
                  borderTop="1px solid"
                  borderColor="rgba(255,255,255,0.05)"
                  flexWrap="wrap"
                >
                  <VStack
                    align="start"
                    gap={0}
                    w={{ base: "100%", md: "32%" }}
                    minW={0}
                  >
                    <Text
                      color={theme.text.primary}
                      truncate
                      maxW="100%"
                      title={item.path}
                    >
                      {item === master ? "★ " : ""}
                      {item.name}
                    </Text>
                    <Text color={theme.text.muted} truncate maxW="100%">
                      {[
                        item.group,
                        ROLE_LABEL[item.role],
                        time(item.durationSec),
                        item.folder &&
                        item.folder.split("/").pop() !== item.group
                          ? item.folder
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </VStack>
                  <Text
                    color={toneColor[state.tone]}
                    flex="1"
                    minW="180px"
                    textAlign="left"
                  >
                    {state.tone === "check" ? "Check: " : ""}
                    {state.label}
                  </Text>
                  <HStack gap={1} flexWrap="wrap" justify="flex-end" ml="auto">
                    {synced ? (
                      <>
                        {item.hasAudio ? (
                          <button
                            type="button"
                            style={nudgeButton}
                            onClick={() => void listen(item.path)}
                            title="Recorder in your left ear, this file in your right: in sync they sound like one voice in the middle"
                          >
                            {listening === item.path ? "■ Stop" : "▶ Listen"}
                          </button>
                        ) : null}
                        {[
                          ["−1s", -1],
                          ["−1f", -frame],
                          ["+1f", frame],
                          ["+1s", 1],
                        ].map(([label, by]) => (
                          <button
                            key={label as string}
                            type="button"
                            style={nudgeButton}
                            onClick={() => nudge(item.path, by as number)}
                            disabled={Boolean(busy)}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          type="button"
                          style={nudgeButton}
                          onClick={() => void fineTune(item.path)}
                          disabled={Boolean(busy)}
                        >
                          Fine-tune
                        </button>
                        <button
                          type="button"
                          style={nudgeButton}
                          onClick={() =>
                            setItem(item.path, {
                              offsetSec: null,
                              drift: 0,
                              sync: undefined,
                            })
                          }
                          disabled={Boolean(busy)}
                          title="Take this file out of the sync"
                        >
                          Unlink
                        </button>
                      </>
                    ) : item !== master && item.role !== "broll" ? (
                      <input
                        placeholder="starts at m:ss ↵"
                        style={{
                          ...field,
                          padding: "1px 6px",
                          fontSize: 12,
                          width: 130,
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const sec = parseTime(
                            (e.target as HTMLInputElement).value,
                          );
                          if (sec !== null)
                            setItem(item.path, {
                              offsetSec: sec,
                              drift: 0,
                              sync: {
                                method: "manual",
                                agreed: 0,
                                tried: 0,
                                refined: false,
                              },
                            });
                        }}
                        aria-label={`Line up ${item.name}: where it starts on the recorder's time`}
                        title="Where this file starts on the recorder's time, then press Enter"
                      />
                    ) : null}
                  </HStack>
                </HStack>
              );
            })}
          </StepCard>

          <StepCard
            number={2}
            title="Story"
            hint="Click a part to see its words and trim inside it. Reorder or remove parts, or pick the camera for a part."
          >
            <HStack
              gap={2}
              flexWrap="wrap"
              fontSize="xs"
              color={theme.text.muted}
              pb={1}
            >
              <Text>
                {draft.activity
                  ? "Auto camera cuts to whoever is talking."
                  : "Auto camera changes at sentence breaks for variety."}
              </Text>
              {isTauri() ? (
                <OutlinedActionButton
                  h="24px"
                  px={2}
                  fontSize="xs"
                  onClick={() => void followSpeakers()}
                  disabled={Boolean(busy)}
                  title="Finds each camera's faces and cuts to whoever is talking (takes a few minutes)"
                >
                  {draft.activity
                    ? "Analyse new parts"
                    : "Follow who's talking"}
                </OutlinedActionButton>
              ) : null}
            </HStack>
            {parts.map((part, index) => {
              const cameras = camerasForPart(draft.items, part);
              return (
                <React.Fragment key={`${part.title}-${part.startSec}-${index}`}>
                  <HStack
                    gap={2}
                    fontSize="sm"
                    py={1}
                    borderTop="1px solid"
                    borderColor="rgba(255,255,255,0.05)"
                  >
                    <Text minW="20px" color={theme.text.muted}>
                      {index + 1}.
                    </Text>
                    <Text
                      flex={1}
                      truncate
                      title={
                        part.kind === "talk"
                          ? "Click to see and trim its words"
                          : part.title
                      }
                      cursor={part.kind === "talk" ? "pointer" : undefined}
                      color={
                        openPart === index ? theme.text.primary : undefined
                      }
                      onClick={() => {
                        setOpenPart(openPart === index ? null : index);
                        setSelection(null);
                      }}
                    >
                      {part.kind === "talk" ? "💬" : "♪"} {part.title}{" "}
                      <Text as="span" color={theme.text.muted} fontSize="xs">
                        {time(part.endSec - part.startSec)}
                      </Text>
                    </Text>
                    {cameras.length > 1 ? (
                      <select
                        value={draft.cameraFor[index] ?? ""}
                        onChange={(e) => pickCamera(index, e.target.value)}
                        style={{ ...field, padding: "2px 4px", fontSize: 12 }}
                        aria-label="Camera"
                      >
                        <option value="">Auto camera</option>
                        {cameras.map((camera) => (
                          <option key={camera.path} value={camera.path}>
                            {camera.group
                              ? `${camera.group} (${camera.name})`
                              : camera.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <button
                      type="button"
                      style={iconButton}
                      onClick={() => index > 0 && move(index, -1)}
                      aria-label="Move up"
                      title="Move up"
                      disabled={index === 0}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      style={iconButton}
                      onClick={() => index < parts.length - 1 && move(index, 1)}
                      aria-label="Move down"
                      title="Move down"
                      disabled={index === parts.length - 1}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      style={iconButton}
                      onClick={() => remove(index)}
                      aria-label="Remove"
                      title="Remove this part"
                    >
                      <X size={14} />
                    </button>
                  </HStack>
                  {openPart === index && part.kind === "talk" ? (
                    <VStack align="stretch" gap={2} pl={7} pb={2}>
                      <Text fontSize="sm" lineHeight="1.8">
                        {draft.words
                          .slice(part.wordStartIdx, part.wordEndIdx + 1)
                          .map((word, k) => {
                            const idx = part.wordStartIdx + k;
                            const lo = selection
                              ? Math.min(selection.from, selection.to)
                              : -1;
                            const hi = selection
                              ? Math.max(selection.from, selection.to)
                              : -1;
                            const selected = idx >= lo && idx <= hi;
                            return (
                              <span
                                key={idx}
                                onClick={(e) =>
                                  setSelection(
                                    e.shiftKey && selection
                                      ? { from: selection.from, to: idx }
                                      : { from: idx, to: idx },
                                  )
                                }
                                style={{
                                  cursor: "pointer",
                                  padding: "1px 2px",
                                  borderRadius: 3,
                                  background: selected
                                    ? "rgba(120,160,255,0.35)"
                                    : undefined,
                                }}
                              >
                                {word.text}{" "}
                              </span>
                            );
                          })}
                      </Text>
                      <HStack
                        gap={2}
                        fontSize="xs"
                        color={theme.text.muted}
                        flexWrap="wrap"
                      >
                        <Text>
                          Click a word, then shift-click another to select a
                          stretch.
                        </Text>
                        <OutlinedActionButton
                          h="24px"
                          px={2}
                          fontSize="xs"
                          onClick={() => editWords(index, "keep")}
                          disabled={!selection}
                        >
                          Keep only this
                        </OutlinedActionButton>
                        <OutlinedActionButton
                          h="24px"
                          px={2}
                          fontSize="xs"
                          onClick={() => editWords(index, "cut")}
                          disabled={!selection}
                        >
                          Cut this out
                        </OutlinedActionButton>
                      </HStack>
                    </VStack>
                  ) : null}
                </React.Fragment>
              );
            })}
          </StepCard>

          <StepCard
            number={3}
            title="Finish"
            hint="Both follow your changes above."
          >
            <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={3}>
              <VStack
                align="stretch"
                gap={2}
                p={3}
                borderRadius="md"
                bg="rgba(255,255,255,0.03)"
              >
                <Text fontSize="sm" fontWeight="semibold">
                  In Premiere or DaVinci Resolve
                </Text>
                <Text fontSize="xs" color={theme.text.muted}>
                  Premiere: File → Import the .xml. Resolve: File → Import →
                  Timeline. V1 is the cut, V2 the B-roll, one switched-off track
                  per camera above; A1 the recorder, A2 the cameras&apos; own
                  sound (muted).
                </Text>
                {written ? (
                  <Text
                    fontSize="xs"
                    color={
                      written.stale ? theme.status.warning : theme.text.muted
                    }
                  >
                    {written.stale
                      ? "Changed since the files were written: update them. "
                      : ""}
                    {written.files.join(" and ")} in {written.folder}
                  </Text>
                ) : null}
                <HStack gap={2} flexWrap="wrap">
                  <OutlinedActionButton
                    h="30px"
                    px={3}
                    fontSize="xs"
                    onClick={() => void exportFiles()}
                    disabled={Boolean(busy)}
                  >
                    {written
                      ? "Update the timeline files"
                      : "Write the timeline files"}
                  </OutlinedActionButton>
                  <OutlinedActionButton
                    h="30px"
                    px={3}
                    fontSize="xs"
                    onClick={() => void openClipperExportsDir(draft.projectId)}
                  >
                    Open the folder
                  </OutlinedActionButton>
                </HStack>
              </VStack>
              <VStack
                align="stretch"
                gap={2}
                p={3}
                borderRadius="md"
                bg="rgba(255,255,255,0.03)"
              >
                <Text fontSize="sm" fontWeight="semibold">
                  Render an MP4 here
                </Text>
                <HStack gap={3} flexWrap="wrap" fontSize="xs">
                  <label>
                    <input
                      type="checkbox"
                      checked={!draft.noBroll}
                      onChange={(e) =>
                        change({ ...draft, noBroll: !e.target.checked })
                      }
                    />{" "}
                    B-roll ({timeline.broll.length})
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={captions}
                      onChange={(e) => setCaptions(e.target.checked)}
                    />{" "}
                    Burn in captions
                  </label>
                  <select
                    value={maxHeight}
                    onChange={(e) => setMaxHeight(Number(e.target.value))}
                    style={{ ...field, padding: "2px 4px", fontSize: 12 }}
                    aria-label="Size"
                  >
                    <option value={0}>Full size (slowest)</option>
                    <option value={2160}>Up to 4K</option>
                    <option value={1080}>1080p</option>
                    <option value={720}>720p (quick look)</option>
                  </select>
                </HStack>
                <HStack gap={2} flexWrap="wrap">
                  <OutlinedActionButton
                    h="30px"
                    px={3}
                    fontSize="xs"
                    onClick={() => void render()}
                    disabled={Boolean(busy)}
                  >
                    Render the MP4
                  </OutlinedActionButton>
                  {rendered ? (
                    <OutlinedActionButton
                      h="30px"
                      px={3}
                      fontSize="xs"
                      onClick={() =>
                        void revealClipperExportInFolder(
                          draft.projectId,
                          rendered.path.split(/[\\/]/).pop() ?? rendered.path,
                        )
                      }
                    >
                      Show the MP4
                    </OutlinedActionButton>
                  ) : null}
                </HStack>
                {rendered ? (
                  <Text fontSize="xs" color={theme.text.muted}>
                    Rendered with {rendered.via}
                  </Text>
                ) : null}
              </VStack>
            </Grid>
          </StepCard>
        </VStack>
      ) : null}
    </VStack>
  );
};

function StepCard({
  number,
  title,
  hint,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { theme } = useClipperUi();
  return (
    <VStack
      align="stretch"
      gap={1}
      p={3}
      borderRadius="lg"
      border="1px solid"
      borderColor={theme.surface.hover}
      bg="rgba(0,0,0,0.18)"
    >
      <HStack gap={2}>
        <Text fontSize="xs" fontWeight="bold" color={theme.text.muted}>
          {number}
        </Text>
        <Text fontSize="sm" fontWeight="semibold">
          {title}
        </Text>
      </HStack>
      {hint ? (
        <Text fontSize="xs" color={theme.text.muted} pb={1}>
          {hint}
        </Text>
      ) : null}
      {children}
    </VStack>
  );
}
