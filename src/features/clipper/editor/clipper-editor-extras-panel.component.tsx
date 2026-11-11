import React, { useRef, useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Image, Music, Sparkles, Trash2 } from "lucide-react";
import type { WordCue } from "../lib/media/transcription-export.util";
import { pickHookLocally, pickHookWithAi } from "./hook.util";
import { describeAiChoice, resolveAiChoice } from "./ai-editor/ai-choice.util";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import { DEFAULT_PROGRESS_BAR, DEFAULT_SOUND_EFFECTS, formatEditorTime, type ClipEdit } from "./clip-edit.util";
import { saveEditorAsset } from "./editor-assets.util";
import { Section, SliderRow, fieldStyle } from "./clipper-editor-side-panel.component";

interface ExtrasPanelProps {
  edit: ClipEdit;
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
  outputTime: number;
  onSeekOutput?: (outputTime: number) => void;
  defaultCoverTitle?: string;
  words?: readonly WordCue[];
  sourceDuration?: number;
  onPreviewHook?: () => void;
}

const checkboxLabel: React.CSSProperties = { fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" };

/** Music, sound effects and the progress bar: things added on top of the clip when it's saved. */
export const ClipperEditorExtrasPanel: React.FC<ExtrasPanelProps> = ({
  edit,
  onChange,
  outputTime,
  onSeekOutput,
  defaultCoverTitle,
  words = [],
  sourceDuration = 0,
  onPreviewHook,
}) => {
  const { theme } = useClipperUi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const music = edit.music ?? null;
  const sfx = edit.sfx ?? null;
  const bar = edit.progressBar ?? null;
  const cover = edit.cover ?? null;
  const hook = edit.hook ?? null;
  const [hookBusy, setHookBusy] = useState(false);
  const [hookNote, setHookNote] = useState<{ text: string; error?: boolean } | null>(null);

  const findHook = async () => {
    setHookBusy(true);
    setHookNote(null);
    try {
      let picked = null;
      let how = "picked from the transcript (offline)";
      const choice = await resolveAiChoice().catch(() => null);
      if (choice) {
        try {
          picked = await pickHookWithAi(choice, words, sourceDuration);
          how = `picked by ${describeAiChoice(choice)}`;
        } catch (error) {
          how = `picked offline (${error instanceof Error ? error.message : String(error)})`;
        }
      }
      picked ??= pickHookLocally(words, sourceDuration);
      if (!picked) throw new Error("No line suits a hook (1.5-6.5 s, after the opening).");
      onChange((current) => ({ ...current, hook: picked }));
      setHookNote({ text: `Hook ${how}.` });
    } catch (error) {
      setHookNote({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setHookBusy(false);
    }
  };

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
      <Section title="Hook">
        <Text fontSize="xs" color={theme.text.muted}>
          Plays a strong line from later in the clip first, as a teaser, then the clip from the start.
        </Text>
        {hook ? (
          <VStack align="stretch" gap={1} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
            <Text fontSize="xs">“{hook.text || "Selected line"}”</Text>
            <Text fontSize="xs" color={theme.text.muted}>
              {formatEditorTime(hook.start)}–{formatEditorTime(hook.end)} · adds {(hook.end - hook.start).toFixed(1)}s at the start
            </Text>
          </VStack>
        ) : null}
        <HStack gap={2} flexWrap="wrap">
          <OutlinedActionButton h="28px" px={2} fontSize="xs" startIcon={hookBusy ? <Spinner size="xs" /> : <Sparkles size={13} />} onClick={() => void findHook()} disabled={hookBusy || words.length < 5}>
            {hook ? "Find another" : "Find a hook"}
          </OutlinedActionButton>
          {hook ? (
            <>
              <OutlinedActionButton h="28px" px={2} fontSize="xs" onClick={onPreviewHook}>
                Preview
              </OutlinedActionButton>
              <OutlinedActionButton h="28px" px={2} tone="danger" aria-label="Remove hook" onClick={() => onChange((current) => ({ ...current, hook: null }))}>
                <Trash2 size={13} />
              </OutlinedActionButton>
            </>
          ) : null}
        </HStack>
        {hookNote ? (
          <Text fontSize="xs" color={hookNote.error ? theme.status.danger : theme.text.muted}>
            {hookNote.text}
          </Text>
        ) : null}
      </Section>

      <Section title="Cover">
        {cover ? (
          <>
            <HStack gap={2}>
              <Image size={14} />
              <Box
                as="button"
                fontSize="xs"
                flex={1}
                textAlign="left"
                cursor="pointer"
                color={clipperTheme.accentGlow}
                onClick={() => onSeekOutput?.(cover.time)}
                title="Show the cover frame"
              >
                Frame at {formatEditorTime(cover.time)}
              </Box>
              <OutlinedActionButton
                h="28px"
                px={2}
                fontSize="xs"
                onClick={() => onChange((current) => (current.cover ? { ...current, cover: { ...current.cover, time: outputTime } } : current))}
              >
                Use this frame
              </OutlinedActionButton>
              <OutlinedActionButton h="28px" px={2} tone="danger" aria-label="Remove cover" onClick={() => onChange((current) => ({ ...current, cover: null }))}>
                <Trash2 size={13} />
              </OutlinedActionButton>
            </HStack>
            <input
              value={cover.title}
              maxLength={120}
              onChange={(e) => onChange((current) => (current.cover ? { ...current, cover: { ...current.cover, title: e.target.value } } : current))}
              placeholder="Cover title (optional)"
              aria-label="Cover title"
              style={fieldStyle}
            />
            <label style={checkboxLabel}>
              <input
                type="checkbox"
                checked={cover.firstFrames}
                onChange={(e) => onChange((current) => (current.cover ? { ...current, cover: { ...current.cover, firstFrames: e.target.checked } } : current))}
                style={{ accentColor: clipperTheme.accent }}
              />
              Also show it for the first frames (for apps that use the first frame as the cover)
            </label>
            <Text fontSize="xs" color={theme.text.muted}>
              Saved as a PNG next to the video. Pause on the cover frame to preview the title.
            </Text>
          </>
        ) : (
          <OutlinedActionButton
            startIcon={<Image size={14} />}
            h="32px"
            fontSize="xs"
            onClick={() => onChange((current) => ({ ...current, cover: { time: outputTime, title: defaultCoverTitle ?? "", firstFrames: false } }))}
          >
            Use this frame as the cover
          </OutlinedActionButton>
        )}
      </Section>

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
