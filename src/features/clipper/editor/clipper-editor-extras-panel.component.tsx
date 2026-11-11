import React, { useRef, useState } from "react";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { Music, Trash2 } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import { DEFAULT_PROGRESS_BAR, DEFAULT_SOUND_EFFECTS, type ClipEdit } from "./clip-edit.util";
import { saveEditorAsset } from "./editor-assets.util";
import { Section, SliderRow, fieldStyle } from "./clipper-editor-side-panel.component";

interface ExtrasPanelProps {
  edit: ClipEdit;
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
}

const checkboxLabel: React.CSSProperties = { fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" };

/** Music, sound effects and the progress bar: things added on top of the clip when it's saved. */
export const ClipperEditorExtrasPanel: React.FC<ExtrasPanelProps> = ({ edit, onChange }) => {
  const { theme } = useClipperUi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const music = edit.music ?? null;
  const sfx = edit.sfx ?? null;
  const bar = edit.progressBar ?? null;

  const pickMusic = async (file: File | undefined) => {
    if (!file) return;
    setMusicError(null);
    setSaving(true);
    try {
      const assetId = await saveEditorAsset(file);
      onChange((current) => ({
        ...current,
        music: { assetId, name: file.name, volume: current.music?.volume ?? 0.25, duck: current.music?.duck ?? true, startSec: 0 },
      }));
    } catch (error) {
      setMusicError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <VStack align="stretch" gap={3}>
      <Section title="Music">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
          style={{ display: "none" }}
          onChange={(e) => {
            void pickMusic(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {music ? (
          <>
            <HStack gap={2}>
              <Music size={14} />
              <Text fontSize="xs" flex={1} truncate title={music.name}>
                {music.name}
              </Text>
              <OutlinedActionButton h="28px" px={2} fontSize="xs" onClick={() => fileRef.current?.click()}>
                Change
              </OutlinedActionButton>
              <OutlinedActionButton
                h="28px"
                px={2}
                tone="danger"
                aria-label="Remove music"
                onClick={() => onChange((current) => ({ ...current, music: null }))}
              >
                <Trash2 size={13} />
              </OutlinedActionButton>
            </HStack>
            <SliderRow
              label="Music volume"
              value={music.volume}
              min={0.02}
              max={1}
              step={0.01}
              display={`${Math.round(music.volume * 100)}%`}
              onChange={(volume) => onChange((current) => (current.music ? { ...current, music: { ...current.music, volume } } : current))}
            />
            <label style={checkboxLabel}>
              Start the song at
              <input
                type="number"
                min={0}
                step={1}
                value={Math.round(music.startSec)}
                onChange={(e) =>
                  onChange((current) =>
                    current.music ? { ...current, music: { ...current.music, startSec: Math.max(0, Number(e.target.value) || 0) } } : current,
                  )
                }
                style={{ ...fieldStyle, width: 64, padding: "2px 6px" }}
              />
              s
            </label>
            <label style={checkboxLabel}>
              <input
                type="checkbox"
                checked={music.duck}
                onChange={(e) => onChange((current) => (current.music ? { ...current, music: { ...current.music, duck: e.target.checked } } : current))}
                style={{ accentColor: clipperTheme.accent }}
              />
              Lower the music while someone talks
            </label>
            <Text fontSize="xs" color={theme.text.muted}>
              Music is mixed in when you save. Use music you have the rights to.
            </Text>
          </>
        ) : (
          <OutlinedActionButton startIcon={<Music size={14} />} h="32px" fontSize="xs" onClick={() => fileRef.current?.click()} disabled={saving}>
            {saving ? "Adding…" : "Add background music"}
          </OutlinedActionButton>
        )}
        {musicError ? (
          <Text fontSize="xs" color={theme.status.danger}>
            {musicError}
          </Text>
        ) : null}
      </Section>

      <Section title="Sound effects">
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(sfx?.cuts)}
            onChange={(e) => onChange((current) => ({ ...current, sfx: { ...(current.sfx ?? DEFAULT_SOUND_EFFECTS), cuts: e.target.checked } }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          Whoosh on cuts
        </label>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(sfx?.punchIns)}
            onChange={(e) => onChange((current) => ({ ...current, sfx: { ...(current.sfx ?? DEFAULT_SOUND_EFFECTS), punchIns: e.target.checked } }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          Hit on punch-ins
        </label>
        {sfx && (sfx.cuts || sfx.punchIns) ? (
          <SliderRow
            label="Effects volume"
            value={sfx.volume}
            min={0.05}
            max={1}
            step={0.01}
            display={`${Math.round(sfx.volume * 100)}%`}
            onChange={(volume) => onChange((current) => ({ ...current, sfx: { ...(current.sfx ?? DEFAULT_SOUND_EFFECTS), volume } }))}
          />
        ) : null}
        <Text fontSize="xs" color={theme.text.muted}>
          Added when you save, at most one every 1.2 seconds.
        </Text>
      </Section>

      <Section title="Progress bar">
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(bar)}
            onChange={(e) => onChange((current) => ({ ...current, progressBar: e.target.checked ? { ...DEFAULT_PROGRESS_BAR } : null }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          Show a bar that fills as the clip plays
        </label>
        {bar ? (
          <>
            <HStack gap={3}>
              {(["top", "bottom"] as const).map((position) => (
                <label key={position} style={checkboxLabel}>
                  <input
                    type="radio"
                    checked={bar.position === position}
                    onChange={() => onChange((current) => (current.progressBar ? { ...current, progressBar: { ...current.progressBar, position } } : current))}
                    style={{ accentColor: clipperTheme.accent }}
                  />
                  {position === "top" ? "Top" : "Bottom"}
                </label>
              ))}
              <label style={checkboxLabel}>
                <input
                  type="color"
                  value={bar.color}
                  onChange={(e) =>
                    onChange((current) => (current.progressBar ? { ...current, progressBar: { ...current.progressBar, color: e.target.value } } : current))
                  }
                  style={{ width: 28, height: 22, padding: 0, border: "none", background: "transparent" }}
                />
                Color
              </label>
            </HStack>
            <SliderRow
              label="Thickness"
              value={bar.thickness}
              min={0.003}
              max={0.025}
              step={0.001}
              display={`${(bar.thickness * 100).toFixed(1)}%`}
              onChange={(thickness) => onChange((current) => (current.progressBar ? { ...current, progressBar: { ...current.progressBar, thickness } } : current))}
            />
          </>
        ) : null}
      </Section>
    </VStack>
  );
};
