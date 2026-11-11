import React, { useRef, useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Film, Image, Music, Sparkles, Trash2 } from "lucide-react";
import { INSERT_LAYOUT_LABEL, type ClipInsert, type ClipInsertLayout } from "./broll.util";
import {
  COLOR_STYLE_LABEL,
  isColorGradeActive,
  type ColorCorrection,
  type ColorGrade,
  type ColorStyle,
} from "../engine/render/color-grade.util";

function describeCorrection(c: ColorCorrection): string {
  const pct = (v: number) => `${v >= 1 ? "+" : ""}${Math.round((v - 1) * 100)}%`;
  const cast = Math.abs(c.warmth) < 0.05 ? "no colour cast" : c.warmth > 0 ? "warmed a cool cast" : "cooled a warm cast";
  return `Auto: brightness ${pct(c.brightness)}, contrast ${pct(c.contrast)}, saturation ${pct(c.saturation)}, ${cast}.`;
}
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import type { MusicSection } from "./music-detect.util";
import { hookDuration, pickHookLocally, pickHookWithAi } from "./hook.util";
import { loadEditorAsset } from "./editor-assets.util";
import { decodeAudioFile } from "./audio-extras.util";
import { beatsOnTimeline, detectBeats } from "./beat-sync.util";
import { addChapterCards } from "./chapters.util";
import { describeAiChoice, resolveAiChoice } from "./ai-editor/ai-choice.util";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import {
  createEditId,
  DEFAULT_PROGRESS_BAR,
  DEFAULT_SOUND_EFFECTS,
  formatEditorTime,
  getOutputDuration,
  sourceToOutputTime,
  type ClipEdit,
} from "./clip-edit.util";
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
  /** Measures the clip's colour (needs the project's source video). */
  onMeasureColor?: () => Promise<ColorCorrection | null>;
  /** Finds songs and performances in the export's audio. */
  onFindMusic?: () => Promise<MusicSection[]>;
  captionGroups?: readonly CaptionGroup[];
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
  onMeasureColor,
  onFindMusic,
  captionGroups = [],
}) => {
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicNote, setMusicNote] = useState<string | null>(null);
  const songs = edit.musicSections ?? null;
  const findMusic = async () => {
    if (!onFindMusic) return;
    setMusicBusy(true);
    setMusicNote(null);
    try {
      const found = await onFindMusic();
      onChange((current) => ({ ...current, musicSections: found }));
      setMusicNote(found.length ? null : "No songs or instrumental passages found.");
    } catch (error) {
      setMusicNote(error instanceof Error ? error.message : String(error));
    } finally {
      setMusicBusy(false);
    }
  };
  const { theme } = useClipperUi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const music = edit.music ?? null;
  const sfx = edit.sfx ?? null;
  const bar = edit.progressBar ?? null;
  const cover = edit.cover ?? null;
  const hook = edit.hook ?? null;
  const [chapterBusy, setChapterBusy] = useState(false);
  const [chapterNote, setChapterNote] = useState<string | null>(null);
  const [beatBusy, setBeatBusy] = useState(false);
  const [beatNote, setBeatNote] = useState<string | null>(null);
  const toggleBeatPulse = async (on: boolean) => {
    if (!on || !edit.music) {
      onChange((current) => ({ ...current, beatPulse: null }));
      return;
    }
    setBeatBusy(true);
    setBeatNote(null);
    try {
      const file = await loadEditorAsset(edit.music.assetId);
      if (!file) throw new Error("The music file is no longer saved; pick it again.");
      const length = getOutputDuration(edit.segments) + hookDuration(edit) + 1;
      const audio = await decodeAudioFile(file, edit.music.startSec, length);
      const found = detectBeats(audio);
      if (!found) throw new Error("Couldn't find a steady beat in this song.");
      const songLength = audio.channels[0]!.length / audio.sampleRate;
      const beats = beatsOnTimeline(found.beats, 0, songLength, length);
      onChange((current) => ({ ...current, beatPulse: { beats, strength: 0.03, every: 1, bpm: found.bpm } }));
    } catch (error) {
      setBeatNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBeatBusy(false);
    }
  };
  const grade = edit.colorGrade ?? null;
  const [measuring, setMeasuring] = useState(false);
  const [colorNote, setColorNote] = useState<string | null>(null);
  const setGrade = (patch: Partial<ColorGrade>) =>
    onChange((current) => {
      const next: ColorGrade = { style: "none", intensity: 1, auto: null, ...current.colorGrade, ...patch };
      return { ...current, colorGrade: isColorGradeActive(next) ? next : null };
    });
  const toggleAuto = async (on: boolean) => {
    if (!on) {
      setGrade({ auto: null });
      return;
    }
    if (!onMeasureColor) return;
    setMeasuring(true);
    setColorNote(null);
    try {
      const correction = await onMeasureColor();
      if (!correction) throw new Error("Couldn't read frames from this clip.");
      setGrade({ auto: correction });
      setColorNote(describeCorrection(correction));
    } catch (error) {
      setColorNote(error instanceof Error ? error.message : String(error));
    } finally {
      setMeasuring(false);
    }
  };
  const inserts = edit.inserts ?? [];
  const brollRef = useRef<HTMLInputElement>(null);
  const [brollError, setBrollError] = useState<string | null>(null);
  const outputDuration = getOutputDuration(edit.segments);

  const addBroll = async (file: File | undefined) => {
    if (!file) return;
    setBrollError(null);
    const kind = file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name) ? "video" : "image";
    try {
      const assetId = await saveEditorAsset(file);
      const start = Math.min(outputTime, Math.max(0, outputDuration - 0.5));
      const insert: ClipInsert = {
        id: createEditId("broll"),
        assetId,
        name: file.name,
        kind,
        start,
        end: Math.min(outputDuration, start + 3),
        layout: "top",
      };
      onChange((current) => ({ ...current, inserts: [...(current.inserts ?? []), insert] }));
    } catch (error) {
      setBrollError(error instanceof Error ? error.message : String(error));
    }
  };
  const updateInsert = (id: string, patch: Partial<ClipInsert>) =>
    onChange((current) => ({ ...current, inserts: (current.inserts ?? []).map((item) => (item.id === id ? { ...item, ...patch } : item)) }));
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
      <Section title="Songs and performances">
        <Text fontSize="xs" color={theme.text.muted}>
          Parts where music is playing are never cut by Auto edit, keep their own sound (no voice clean-up), and
          background music steps aside for them.
        </Text>
        <OutlinedActionButton
          h="28px"
          px={2}
          fontSize="xs"
          startIcon={musicBusy ? <Spinner size="xs" /> : <Music size={13} />}
          disabled={musicBusy || !onFindMusic}
          onClick={() => void findMusic()}
        >
          {songs ? "Find again" : "Find songs"}
        </OutlinedActionButton>
        {songs?.length ? (
          <>
            {songs.map((song, index) => (
              <Box
                key={`${song.start}-${index}`}
                as="button"
                fontSize="xs"
                textAlign="left"
                cursor="pointer"
                color={clipperTheme.accentGlow}
                onClick={() => onSeekOutput?.(sourceToOutputTime(edit.segments, song.start + 0.01))}
              >
                ♪ {formatEditorTime(song.start)}–{formatEditorTime(song.end)} ({Math.round(song.end - song.start)}s
                {Math.abs(song.gain - 1) > 0.05 ? `, ${song.gain > 1 ? "+" : ""}${(20 * Math.log10(song.gain)).toFixed(1)} dB to match the talking` : ""})
              </Box>
            ))}
            <label style={checkboxLabel}>
              <input
                type="checkbox"
                checked={Boolean(edit.balanceMusic)}
                onChange={(e) => onChange((current) => ({ ...current, balanceMusic: e.target.checked }))}
                style={{ accentColor: clipperTheme.accent }}
              />
              Match the songs' loudness to the talking
            </label>
            <OutlinedActionButton
              h="26px"
              px={2}
              fontSize="xs"
              title="Where a part starts in a song, its music starts half a second before the picture"
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  segments: current.segments.map((segment, index) =>
                    index > 0 && songs.some((song) => segment.start >= song.start - 0.5 && segment.start < song.end) ? { ...segment, audioOffset: 0.5 } : segment,
                  ),
                }))
              }
            >
              J-cut into songs
            </OutlinedActionButton>
            <OutlinedActionButton
              h="26px"
              px={2}
              fontSize="xs"
              disabled={!captionGroups.length}
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  captionGroups: (current.captionGroups ?? [...captionGroups]).filter((group) => {
                    const middle = (group.start + group.end) / 2;
                    return !songs.some((song) => middle >= song.start && middle < song.end);
                  }),
                }))
              }
            >
              Hide captions during songs
            </OutlinedActionButton>
          </>
        ) : null}
        {musicNote ? (
          <Text fontSize="xs" color={theme.text.muted}>
            {musicNote}
          </Text>
        ) : null}
      </Section>

      <Section title="Color">
        <HStack gap={1} flexWrap="wrap">
          {(Object.keys(COLOR_STYLE_LABEL) as ColorStyle[]).map((style) => (
            <Box
              key={style}
              as="button"
              fontSize="xs"
              px={2}
              py={1}
              borderRadius="sm"
              border="1px solid"
              cursor="pointer"
              borderColor={(grade?.style ?? "none") === style ? clipperTheme.accentGlow : theme.surface.hover}
              bg={(grade?.style ?? "none") === style ? `rgba(${clipperTheme.accentTintRgb},0.2)` : "transparent"}
              onClick={() => onMeasureColor && setGrade({ style })}
              opacity={onMeasureColor ? 1 : 0.5}
            >
              {COLOR_STYLE_LABEL[style]}
            </Box>
          ))}
        </HStack>
        {grade && grade.style !== "none" ? (
          <SliderRow
            label="Strength"
            value={grade.intensity}
            min={0.1}
            max={1}
            step={0.05}
            display={`${Math.round(grade.intensity * 100)}%`}
            onChange={(intensity) => setGrade({ intensity })}
          />
        ) : null}
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(grade?.auto)}
            disabled={!onMeasureColor || measuring}
            onChange={(e) => void toggleAuto(e.target.checked)}
            style={{ accentColor: clipperTheme.accent }}
          />
          {measuring ? "Measuring the clip…" : "Auto-correct exposure, contrast and colour cast"}
        </label>
        <Text fontSize="xs" color={theme.text.muted}>
          {onMeasureColor
            ? (colorNote ?? "Applied to the picture under the captions; the preview shows it.")
            : "Needs the project's source video (open the project)."}
        </Text>
      </Section>

      <Section title="Stabilize">
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(edit.stabilize)}
            onChange={(e) => onChange((current) => ({ ...current, stabilize: e.target.checked ? { strength: 0.6 } : null }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          Remove camera shake
        </label>
        {edit.stabilize ? (
          <SliderRow
            label="Strength"
            value={edit.stabilize.strength}
            min={0.2}
            max={1}
            step={0.05}
            display={`${Math.round(edit.stabilize.strength * 100)}%`}
            onChange={(strength) => onChange((current) => ({ ...current, stabilize: { strength } }))}
          />
        ) : null}
        <Text fontSize="xs" color={theme.text.muted}>
          For handheld footage. Applied when you save (the picture zooms in slightly to hide the edges); the preview
          isn't stabilised.
        </Text>
      </Section>

      <Section title="B-roll">
        <input
          ref={brollRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: "none" }}
          onChange={(e) => {
            void addBroll(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <OutlinedActionButton h="32px" fontSize="xs" startIcon={<Film size={14} />} onClick={() => brollRef.current?.click()}>
          Add image or video at the playhead
        </OutlinedActionButton>
        {inserts.map((insert) => (
          <VStack key={insert.id} align="stretch" gap={1} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
            <HStack gap={2}>
              <Box as="button" flex={1} textAlign="left" fontSize="xs" truncate title="Jump to it" cursor="pointer" onClick={() => onSeekOutput?.(insert.start + 0.01)}>
                {insert.kind === "video" ? "🎞️" : "🖼️"} {insert.name}
              </Box>
              <OutlinedActionButton
                h="26px"
                px={2}
                tone="danger"
                aria-label="Remove B-roll"
                onClick={() => onChange((current) => ({ ...current, inserts: (current.inserts ?? []).filter((item) => item.id !== insert.id) }))}
              >
                <Trash2 size={12} />
              </OutlinedActionButton>
            </HStack>
            <HStack gap={2} fontSize="xs">
              <OutlinedActionButton h="24px" px={2} fontSize="xs" onClick={() => updateInsert(insert.id, { start: Math.min(outputTime, insert.end - 0.3) })}>
                Start here
              </OutlinedActionButton>
              <OutlinedActionButton h="24px" px={2} fontSize="xs" onClick={() => updateInsert(insert.id, { end: Math.max(outputTime, insert.start + 0.3) })}>
                End here
              </OutlinedActionButton>
              <Text color={theme.text.muted}>
                {formatEditorTime(insert.start)}–{formatEditorTime(insert.end)}
              </Text>
            </HStack>
            <select
              value={insert.layout}
              onChange={(e) => updateInsert(insert.id, { layout: e.target.value as ClipInsertLayout })}
              style={{ ...fieldStyle, padding: "2px 6px" }}
              aria-label="B-roll layout"
            >
              {(Object.keys(INSERT_LAYOUT_LABEL) as ClipInsertLayout[]).map((layout) => (
                <option key={layout} value={layout}>
                  {INSERT_LAYOUT_LABEL[layout]}
                </option>
              ))}
            </select>
          </VStack>
        ))}
        {brollError ? (
          <Text fontSize="xs" color={theme.status.danger}>
            {brollError}
          </Text>
        ) : null}
      </Section>

      <Section title="Chapter cards">
        <Text fontSize="xs" color={theme.text.muted}>
          The AI finds where the topic or step changes and adds a short title card there (as text you can edit).
        </Text>
        <OutlinedActionButton
          h="28px"
          px={2}
          fontSize="xs"
          startIcon={chapterBusy ? <Spinner size="xs" /> : <Sparkles size={13} />}
          disabled={chapterBusy || words.length < 20}
          onClick={() => {
            setChapterBusy(true);
            setChapterNote(null);
            void resolveAiChoice()
              .then((choice) => addChapterCards(choice, edit, words))
              .then((result) => {
                onChange(() => result.edit);
                setChapterNote(result.count ? `Added ${result.count} chapter card${result.count === 1 ? "" : "s"}.` : "The AI didn't find clear topic changes.");
              })
              .catch((error: unknown) => setChapterNote(error instanceof Error ? error.message : String(error)))
              .finally(() => setChapterBusy(false));
          }}
        >
          Add chapter cards
        </OutlinedActionButton>
        {chapterNote ? (
          <Text fontSize="xs" color={theme.text.muted}>
            {chapterNote}
          </Text>
        ) : null}
      </Section>

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
            <label style={checkboxLabel}>
              <input
                type="checkbox"
                checked={Boolean(edit.beatPulse)}
                disabled={beatBusy}
                onChange={(e) => void toggleBeatPulse(e.target.checked)}
                style={{ accentColor: clipperTheme.accent }}
              />
              {beatBusy ? "Finding the beat…" : edit.beatPulse ? `Pulse on the beat (${Math.round(edit.beatPulse.bpm)} BPM)` : "Pulse the picture on the beat"}
            </label>
            {edit.beatPulse ? (
              <HStack gap={3}>
                <Box flex={1}>
                  <SliderRow
                    label="Pulse"
                    value={edit.beatPulse.strength}
                    min={0.01}
                    max={0.08}
                    step={0.005}
                    display={`${(edit.beatPulse.strength * 100).toFixed(1)}%`}
                    onChange={(strength) => onChange((current) => (current.beatPulse ? { ...current, beatPulse: { ...current.beatPulse, strength } } : current))}
                  />
                </Box>
                <select
                  value={edit.beatPulse.every}
                  onChange={(e) => {
                    const every = (Number(e.target.value) === 2 ? 2 : 1) as 1 | 2;
                    onChange((current) => (current.beatPulse ? { ...current, beatPulse: { ...current.beatPulse, every } } : current));
                  }}
                  style={{ ...fieldStyle, width: "auto", padding: "2px 6px" }}
                  aria-label="Pulse frequency"
                >
                  <option value={1}>Every beat</option>
                  <option value={2}>Every other beat</option>
                </select>
              </HStack>
            ) : null}
            {beatNote ? (
              <Text fontSize="xs" color={theme.text.muted}>
                {beatNote}
              </Text>
            ) : null}
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

      <Section title="Voice">
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(edit.voiceCleanup?.denoise)}
            onChange={(e) => onChange((current) => ({ ...current, voiceCleanup: { compress: current.voiceCleanup?.compress ?? false, denoise: e.target.checked } }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          Reduce background noise and rumble
        </label>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={Boolean(edit.voiceCleanup?.compress)}
            onChange={(e) => onChange((current) => ({ ...current, voiceCleanup: { denoise: current.voiceCleanup?.denoise ?? false, compress: e.target.checked } }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          Even out loud and quiet words
        </label>
        <Text fontSize="xs" color={theme.text.muted}>
          Applied when you save; the preview plays the original sound.
        </Text>
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
