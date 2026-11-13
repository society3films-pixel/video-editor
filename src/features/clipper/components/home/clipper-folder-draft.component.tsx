import React, { useEffect, useRef, useState } from "react";
import { HStack, Spinner, Text, VStack } from "@chakra-ui/react";
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
  const [rendered, setRendered] = useState<string | null>(null);
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
      const path = await renderFolderDraft(draft, {
        captions,
        maxHeight: maxHeight || undefined,
        signal,
        onProgress: (ratio) => setBusy({ step: "Rendering the MP4", ratio }),
      });
      setRendered(path);
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
          disabled={Boolean(busy)}
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
        Put every file from a shoot in one folder: interview cameras, the sound
        recorder&apos;s files, performance takes, B-roll. The app sorts them,
        lines them up by sound, transcribes the recorder, has your AI build a
        story, and gives you a multicam timeline to finish in Premiere or
        DaVinci Resolve, or a video rendered here. Runs on this computer.
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
            disabled={Boolean(busy)}
          >
            Build the draft
          </OutlinedActionButton>
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
        <VStack
          align="stretch"
          gap={2}
          p={3}
          borderRadius="md"
          bg="rgba(0,0,0,0.2)"
        >
          <Text fontSize="sm" fontWeight="semibold">
            {draft.name}: {time(timeline.durationSec)}, {parts.length} parts (
            {draft.ai})
          </Text>

          <Text fontSize="xs" fontWeight="semibold">
            Finish in Premiere or Resolve
          </Text>
          <Text fontSize="xs" color={theme.text.muted}>
            {written
              ? `${written.files.join(" and ")} in ${written.folder}${written.stale ? " (changed since; update them)" : ""}. `
              : ""}
            Premiere: File → Import the .xml. DaVinci Resolve: File → Import →
            Timeline. Track V1 is the camera cuts, V2 the B-roll, A1 the
            recorder, A2 each camera&apos;s own sound (muted, for checking
            sync); markers name the parts.
          </Text>
          <HStack gap={2} flexWrap="wrap">
            <OutlinedActionButton
              h="28px"
              px={2}
              fontSize="xs"
              onClick={() => void exportFiles()}
              disabled={Boolean(busy)}
            >
              {written
                ? "Update the timeline files"
                : "Write the timeline files"}
            </OutlinedActionButton>
            <OutlinedActionButton
              h="28px"
              px={2}
              fontSize="xs"
              onClick={() => void openClipperExportsDir(draft.projectId)}
            >
              Open the folder
            </OutlinedActionButton>
          </HStack>

          <Text fontSize="xs" fontWeight="semibold" mt={1}>
            Or finish here
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
            <OutlinedActionButton
              h="28px"
              px={2}
              fontSize="xs"
              onClick={() => void render()}
              disabled={Boolean(busy)}
            >
              Render the MP4
            </OutlinedActionButton>
            {rendered ? (
              <OutlinedActionButton
                h="28px"
                px={2}
                fontSize="xs"
                onClick={() =>
                  void revealClipperExportInFolder(
                    draft.projectId,
                    rendered.split(/[\\/]/).pop() ?? rendered,
                  )
                }
              >
                Show the MP4
              </OutlinedActionButton>
            ) : null}
          </HStack>

          <Text fontSize="xs" fontWeight="semibold" mt={1}>
            Story (click a part to trim its words; reorder, remove, or pick the
            camera; both outputs follow)
          </Text>
          <HStack
            gap={2}
            flexWrap="wrap"
            fontSize="xs"
            color={theme.text.muted}
          >
            <Text>
              {draft.activity
                ? "Auto camera cuts to whoever is talking (faces analysed)."
                : "Auto camera changes at sentence breaks for variety."}
            </Text>
            {isTauri() ? (
              <OutlinedActionButton
                h="24px"
                px={2}
                fontSize="xs"
                onClick={() => void followSpeakers()}
                disabled={Boolean(busy)}
              >
                {draft.activity ? "Analyse new parts" : "Follow who's talking"}
              </OutlinedActionButton>
            ) : null}
          </HStack>
          {parts.map((part, index) => {
            const cameras = camerasForPart(draft.items, part);
            return (
              <React.Fragment key={`${part.title}-${part.startSec}-${index}`}>
                <HStack gap={2} fontSize="xs" color={theme.text.muted}>
                  <Text minW="18px">{index + 1}.</Text>
                  <Text
                    flex={1}
                    truncate
                    title={part.title}
                    cursor={part.kind === "talk" ? "pointer" : undefined}
                    onClick={() => {
                      setOpenPart(openPart === index ? null : index);
                      setSelection(null);
                    }}
                  >
                    {part.kind === "talk" ? "💬" : "♪"} {part.title} (
                    {time(part.endSec - part.startSec)})
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
                          {camera.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button
                    type="button"
                    style={iconButton}
                    onClick={() => index > 0 && move(index, -1)}
                    aria-label="Move up"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    style={iconButton}
                    onClick={() => index < parts.length - 1 && move(index, 1)}
                    aria-label="Move down"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    style={iconButton}
                    onClick={() => remove(index)}
                    aria-label="Remove"
                  >
                    <X size={13} />
                  </button>
                </HStack>
                {openPart === index && part.kind === "talk" ? (
                  <VStack align="stretch" gap={1} pl={6} pb={1}>
                    <Text fontSize="xs" lineHeight="1.7">
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
                      <Text>Click a word, shift-click another to select.</Text>
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

          <Text fontSize="xs" fontWeight="semibold" mt={1}>
            Files
          </Text>
          <Text fontSize="xs" color={theme.text.muted}>
            Out of sync? Nudge a file by a frame or a second, then Fine-tune
            locks it to the sound nearby.
          </Text>
          {draft.items.map((item) => {
            const synced = item.offsetSec !== null && item !== master;
            const frame = 1 / (item.fps || 25);
            const status =
              item === master
                ? " (master sound)"
                : item.offsetSec !== null
                  ? `, lined up at ${item.offsetSec < 0 ? "-" : ""}${time(Math.abs(item.offsetSec))}${syncDetail(item)}`
                  : item.role === "broll"
                    ? ""
                    : item.role === "performance"
                      ? ", separate take (placed whole)"
                      : ", couldn't be lined up";
            return (
              <HStack
                key={item.path}
                gap={1}
                fontSize="xs"
                flexWrap="wrap"
                color={
                  item.offsetSec === null && item.role !== "broll"
                    ? theme.status.warning
                    : theme.text.muted
                }
              >
                <Text>
                  {item === master ? "★ " : ""}
                  {item.folder ? `${item.folder}/` : ""}
                  {item.name}: {ROLE_LABEL[item.role]}, {time(item.durationSec)}
                  {status}
                </Text>
                {synced ? (
                  <>
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
                    >
                      Unlink
                    </button>
                  </>
                ) : item !== master && item.role !== "broll" ? (
                  <input
                    placeholder="line up at m:ss"
                    style={{
                      ...field,
                      padding: "1px 6px",
                      fontSize: 12,
                      width: 120,
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
                    aria-label={`Line up ${item.name} at`}
                  />
                ) : null}
              </HStack>
            );
          })}
        </VStack>
      ) : null}
    </VStack>
  );
};
