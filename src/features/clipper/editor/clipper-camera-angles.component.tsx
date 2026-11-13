import React, { useRef, useState } from "react";
import { HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Camera, Trash2 } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import { createEditId, type ClipEdit } from "./clip-edit.util";
import { Section, SliderRow } from "./clipper-editor-side-panel.component";
import { saveEditorAsset } from "./editor-assets.util";
import { pickMediaFiles } from "./pick-files.util";
import type { ClipAngle } from "./multicam.util";

/** Extra cameras: add, sync by sound, frame, and use for songs. */
export const ClipperCameraAngles: React.FC<{
  edit: ClipEdit;
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
  /** Lines an angle file up with the main camera by sound (needs the project's source video). */
  onSyncAngle?: (file: File) => Promise<{ offsetSec: number; confidence: number }>;
}> = ({ edit, onChange, onSyncAngle }) => {
  const { theme } = useClipperUi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const angles = edit.angles ?? [];
  const update = (id: string, patch: Partial<ClipAngle>) =>
    onChange((current) => ({ ...current, angles: (current.angles ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)) }));

  const add = async (file: File | undefined) => {
    if (!file || !onSyncAngle) return;
    setBusy(true);
    setNote(null);
    try {
      const sync = await onSyncAngle(file);
      const assetId = await saveEditorAsset(file);
      const angle: ClipAngle = { id: createEditId("angle"), assetId, name: file.name, ...sync, x: 0.5, y: 0.45, zoom: 1 };
      onChange((current) => ({ ...current, angles: [...(current.angles ?? []), angle] }));
      setNote(
        sync.confidence < 0.35
          ? `Lined up, but the sound match was weak (${Math.round(sync.confidence * 100)}%). Check it in the preview and nudge if needed.`
          : `Lined up by sound (${Math.round(sync.confidence * 100)}% match).`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Camera angles">
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={(e) => {
          void add(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <OutlinedActionButton
        h="30px"
        fontSize="xs"
        startIcon={busy ? <Spinner size="xs" /> : <Camera size={14} />}
        onClick={() => void pickMediaFiles("video").then((files) => add(files[0]))}
        disabled={busy || !onSyncAngle}
      >
        {busy ? "Lining up by sound…" : "Add a camera angle"}
      </OutlinedActionButton>
      <Text fontSize="xs" color={theme.text.muted}>
        {onSyncAngle
          ? "Another camera's recording of the same session (its sound lines it up). Pick an angle per part in Part, or use one for every song."
          : "Needs the project's source video (open the project)."}
      </Text>
      {angles.map((angle) => (
        <VStack key={angle.id} align="stretch" gap={1} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
          <HStack gap={2}>
            <Text fontSize="xs" flex={1} truncate title={angle.name}>
              🎥 {angle.name}
            </Text>
            <OutlinedActionButton
              h="24px"
              px={2}
              tone="danger"
              aria-label="Remove angle"
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  angles: (current.angles ?? []).filter((a) => a.id !== angle.id),
                  angleForSongs: current.angleForSongs === angle.id ? null : current.angleForSongs,
                  segments: current.segments.map((s) => (s.angle === angle.id ? { ...s, angle: undefined } : s)),
                }))
              }
            >
              <Trash2 size={12} />
            </OutlinedActionButton>
          </HStack>
          <SliderRow
            label="Sync nudge"
            value={angle.offsetSec}
            min={angle.offsetSec - 1}
            max={angle.offsetSec + 1}
            step={0.02}
            display={`${angle.offsetSec >= 0 ? "+" : ""}${angle.offsetSec.toFixed(2)}s`}
            onChange={(offsetSec) => update(angle.id, { offsetSec })}
          />
          <SliderRow label="Left / right" value={angle.x} min={0} max={1} step={0.01} display={`${Math.round(angle.x * 100)}%`} onChange={(x) => update(angle.id, { x })} />
          <SliderRow label="Zoom" value={angle.zoom} min={1} max={3} step={0.05} display={`${Math.round(angle.zoom * 100)}%`} onChange={(zoom) => update(angle.id, { zoom })} />
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={edit.angleForSongs === angle.id}
              onChange={(e) => onChange((current) => ({ ...current, angleForSongs: e.target.checked ? angle.id : null }))}
              style={{ accentColor: clipperTheme.accent }}
            />
            Use during songs{edit.musicSections?.length ? "" : " (find songs first)"}
          </label>
        </VStack>
      ))}
      {note ? (
        <Text fontSize="xs" color={theme.text.muted}>
          {note}
        </Text>
      ) : null}
    </Section>
  );
};
