import React from "react";
import { Box, Flex, HStack, Text, VStack } from "@chakra-ui/react";
import { Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import { ClipperEditorExtrasPanel } from "./clipper-editor-extras-panel.component";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import { ClipperEditTemplates } from "./clipper-edit-templates.component";
import { ClipperBrollLibrary } from "./clipper-broll-library.component";
import type { ColorCorrection } from "../engine/render/color-grade.util";
import type { MusicSection } from "./music-detect.util";
import {
  formatEditorTime,
  type ClipEdit,
  type ClipTextOverlay,
  type ClipTextPosition,
} from "./clip-edit.util";

interface ClipperEditorSidePanelProps {
  edit: ClipEdit;
  outputDuration: number;
  outputTime: number;
  /** Applies a change and records it in undo history. */
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
  onAddText: () => void;
  /** The selected part, or the one under the playhead, for its punch-in zoom. */
  activeSegmentId?: string | null;
  /** Moves the playhead to an output time (the cover frame). */
  onSeekOutput?: (outputTime: number) => void;
  /** Suggested cover title (the export's social title). */
  defaultCoverTitle?: string;
  /** Transcript words (clip-local), for picking a hook. */
  words?: readonly WordCue[];
  sourceDuration?: number;
  onPreviewHook?: () => void;
  /** The clip's caption lines as shown, for templates. */
  captionGroups?: readonly CaptionGroup[];
  onMeasureColor?: () => Promise<ColorCorrection | null>;
  punchInCenter?: (start: number, end: number) => { x: number; y: number } | null;
  onFindMusic?: () => Promise<MusicSection[]>;
  projectId?: string;
}

const POSITIONS: ClipTextPosition[] = ["top", "middle", "bottom"];

export const fieldStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.35)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
  outline: "none",
};

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useClipperUi();
  return (
    <VStack
      align="stretch"
      gap={3}
      p={4}
      borderRadius="lg"
      border="1px solid"
      borderColor={theme.surface.hover}
      bg={theme.surface.faint}
    >
      <Text fontSize="xs" fontWeight="bold" textTransform="uppercase" letterSpacing="wider" color={theme.text.muted}>
        {title}
      </Text>
      {children}
    </VStack>
  );
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const { theme } = useClipperUi();
  return (
    <VStack align="stretch" gap={1}>
      <HStack justify="space-between">
        <Text fontSize="sm" color={theme.text.primary}>
          {label}
        </Text>
        <Text fontSize="xs" color={theme.text.muted}>
          {display}
        </Text>
      </HStack>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: "100%", accentColor: clipperTheme.accent }}
      />
    </VStack>
  );
}

function TextOverlayCard({
  overlay,
  index,
  outputDuration,
  outputTime,
  onUpdate,
  onRemove,
}: {
  overlay: ClipTextOverlay;
  index: number;
  outputDuration: number;
  outputTime: number;
  onUpdate: (patch: Partial<ClipTextOverlay>) => void;
  onRemove: () => void;
}) {
  const { theme } = useClipperUi();
  const active = outputTime >= overlay.start && outputTime < overlay.end;
  const setTime = (key: "start" | "end", raw: number) => {
    if (!Number.isFinite(raw)) return;
    const value = Math.min(outputDuration, Math.max(0, raw));
    if (key === "start") onUpdate({ start: Math.min(value, overlay.end - 0.1) });
    else onUpdate({ end: Math.max(value, overlay.start + 0.1) });
  };

  return (
    <VStack
      align="stretch"
      gap={2}
      p={3}
      borderRadius="md"
      border="1px solid"
      borderColor={active ? clipperTheme.accentGlow : theme.surface.hover}
      bg="rgba(0,0,0,0.2)"
    >
      <HStack justify="space-between">
        <Text fontSize="xs" fontWeight="semibold" color={theme.text.muted}>
          Text {index + 1}
        </Text>
        <Box
          as="button"
          aria-label="Remove text"
          color={theme.text.muted}
          _hover={{ color: theme.status.danger }}
          onClick={onRemove}
          cursor="pointer"
        >
          <Trash2 size={14} />
        </Box>
      </HStack>
      <textarea
        value={overlay.text}
        rows={2}
        onChange={(event) => onUpdate({ text: event.target.value })}
        style={{ ...fieldStyle, resize: "vertical", fontFamily: "inherit" }}
      />
      <HStack gap={2}>
        {(["start", "end"] as const).map((key) => (
          <VStack key={key} align="stretch" gap={1} flex={1}>
            <Text fontSize="xs" color={theme.text.muted}>
              {key === "start" ? "Start (s)" : "End (s)"}
            </Text>
            <HStack gap={1}>
              <input
                type="number"
                step={0.1}
                min={0}
                max={outputDuration}
                value={Number(overlay[key].toFixed(2))}
                onChange={(event) => setTime(key, Number(event.target.value))}
                style={fieldStyle}
              />
              <Box
                as="button"
                title={`Set ${key} to playhead (${formatEditorTime(outputTime)})`}
                fontSize="10px"
                px={2}
                py={1}
                borderRadius="sm"
                border="1px solid"
                borderColor={theme.surface.hover}
                color={theme.text.primary}
                whiteSpace="nowrap"
                cursor="pointer"
                _hover={{ borderColor: clipperTheme.accentGlow }}
                onClick={() => setTime(key, outputTime)}
              >
                Now
              </Box>
            </HStack>
          </VStack>
        ))}
      </HStack>
      <HStack gap={1}>
        {POSITIONS.map((position) => (
          <Box
            key={position}
            as="button"
            flex={1}
            fontSize="xs"
            py={1}
            borderRadius="sm"
            border="1px solid"
            textTransform="capitalize"
            cursor="pointer"
            borderColor={overlay.position === position ? clipperTheme.accentGlow : theme.surface.hover}
            bg={overlay.position === position ? `rgba(${clipperTheme.accentTintRgb},0.2)` : "transparent"}
            color={theme.text.primary}
            onClick={() => onUpdate({ position })}
          >
            {position}
          </Box>
        ))}
      </HStack>
      <SliderRow
        label="Size"
        value={overlay.size}
        min={0.03}
        max={0.14}
        step={0.005}
        display={`${Math.round(overlay.size * 100)}%`}
        onChange={(size) => onUpdate({ size })}
      />
      <HStack justify="space-between">
        <HStack gap={2}>
          <input
            type="color"
            value={overlay.color}
            onChange={(event) => onUpdate({ color: event.target.value })}
            style={{ width: 28, height: 24, border: "none", background: "transparent", padding: 0 }}
            aria-label="Text color"
          />
          <Text fontSize="xs" color={theme.text.muted}>
            Color
          </Text>
        </HStack>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={overlay.background}
            onChange={(event) => onUpdate({ background: event.target.checked })}
            style={{ accentColor: clipperTheme.accent }}
          />
          Background box
        </label>
      </HStack>
    </VStack>
  );
}

export const ClipperEditorSidePanel: React.FC<ClipperEditorSidePanelProps> = ({
  edit,
  outputDuration,
  outputTime,
  onChange,
  onAddText,
  activeSegmentId = null,
  onSeekOutput,
  defaultCoverTitle,
  words,
  sourceDuration,
  onPreviewHook,
  captionGroups,
  onMeasureColor,
  punchInCenter,
  onFindMusic,
  projectId,
}) => {
  const activePartIndex = edit.segments.findIndex((segment) => segment.id === activeSegmentId);
  const activePart = activePartIndex >= 0 ? edit.segments[activePartIndex] : undefined;
  const { theme } = useClipperUi();
  const maxFade = Math.max(0, Math.min(3, outputDuration / 2));
  const muted = edit.volume === 0;

  const updateOverlay = (id: string, patch: Partial<ClipTextOverlay>) =>
    onChange((current) => ({
      ...current,
      textOverlays: current.textOverlays.map((overlay) => (overlay.id === id ? { ...overlay, ...patch } : overlay)),
    }));

  return (
    <VStack align="stretch" gap={3}>
      {activePart ? (
        <Section title={edit.segments.length > 1 ? `Part ${activePartIndex + 1}` : "Zoom"}>
          <SliderRow
            label="Punch-in zoom"
            value={activePart.zoom ?? 1}
            min={1}
            max={1.5}
            step={0.01}
            display={`${Math.round((activePart.zoom ?? 1) * 100)}%`}
            onChange={(zoom) =>
              onChange((current) => ({
                ...current,
                segments: current.segments.map((segment) =>
                  segment.id === activePart.id
                    ? {
                        ...segment,
                        zoom: zoom > 1.001 ? zoom : undefined,
                        // Aim at the speaker the first time a part is zoomed.
                        zoomCenter: zoom > 1.001 ? (segment.zoomCenter ?? punchInCenter?.(segment.start, segment.end) ?? undefined) : undefined,
                      }
                    : segment,
                ),
              }))
            }
          />
          {activePartIndex > 0 ? (
            <>
              <SliderRow
                label="Sound before / after the cut (J / L)"
                value={activePart.audioOffset ?? 0}
                min={-1.5}
                max={1.5}
                step={0.05}
                display={
                  !activePart.audioOffset
                    ? "Straight cut"
                    : activePart.audioOffset > 0
                      ? `J: ${activePart.audioOffset.toFixed(2)}s early`
                      : `L: ${(-activePart.audioOffset).toFixed(2)}s late`
                }
                onChange={(audioOffset) =>
                  onChange((current) => ({
                    ...current,
                    segments: current.segments.map((segment) =>
                      segment.id === activePart.id ? { ...segment, audioOffset: Math.abs(audioOffset) < 0.02 ? undefined : audioOffset } : segment,
                    ),
                  }))
                }
              />
              <Text fontSize="xs" color={theme.text.muted}>
                J: this part's sound starts before its picture (good for cutting into a song). L: the last part's sound
                carries on over this picture. Applied when you save.
              </Text>
            </>
          ) : null}
        </Section>
      ) : null}

      <Section title="Audio">
        <HStack gap={3} align="end">
          <Box flex={1}>
            <SliderRow
              label="Volume"
              value={edit.volume}
              min={0}
              max={2}
              step={0.05}
              display={`${Math.round(edit.volume * 100)}%`}
              onChange={(volume) => onChange((current) => ({ ...current, volume }))}
            />
          </Box>
          <Flex
            as="button"
            aria-label={muted ? "Unmute" : "Mute"}
            w="32px"
            h="32px"
            align="center"
            justify="center"
            borderRadius="md"
            border="1px solid"
            borderColor={muted ? theme.status.danger : theme.surface.hover}
            color={muted ? theme.status.danger : theme.text.primary}
            cursor="pointer"
            onClick={() => onChange((current) => ({ ...current, volume: current.volume === 0 ? 1 : 0 }))}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </Flex>
        </HStack>
        {edit.volume > 1 ? (
          <Text fontSize="xs" color={theme.text.muted}>
            Boosts above 100% apply to the saved file; the preview plays at most 100%.
          </Text>
        ) : null}
      </Section>

      {words ? (
        <ClipperEditTemplates
          edit={edit}
          captionGroups={captionGroups ?? []}
          words={words}
          sourceDuration={sourceDuration ?? 0}
          onChange={onChange}
          onMeasureColor={onMeasureColor}
        />
      ) : null}

      {projectId && words ? <ClipperBrollLibrary projectId={projectId} edit={edit} words={words} onChange={onChange} /> : null}

      <ClipperEditorExtrasPanel
        edit={edit}
        onChange={onChange}
        outputTime={outputTime}
        onSeekOutput={onSeekOutput}
        defaultCoverTitle={defaultCoverTitle}
        words={words}
        sourceDuration={sourceDuration}
        onPreviewHook={onPreviewHook}
        onMeasureColor={onMeasureColor}
        onFindMusic={onFindMusic}
        captionGroups={captionGroups}
      />

      <Section title="Fades">
        <SliderRow
          label="Fade in"
          value={edit.fadeInSec}
          min={0}
          max={maxFade}
          step={0.1}
          display={`${edit.fadeInSec.toFixed(1)}s`}
          onChange={(fadeInSec) => onChange((current) => ({ ...current, fadeInSec }))}
        />
        <SliderRow
          label="Fade out"
          value={edit.fadeOutSec}
          min={0}
          max={maxFade}
          step={0.1}
          display={`${edit.fadeOutSec.toFixed(1)}s`}
          onChange={(fadeOutSec) => onChange((current) => ({ ...current, fadeOutSec }))}
        />
      </Section>

      <Section title="Text">
        {edit.textOverlays.map((overlay, index) => (
          <TextOverlayCard
            key={overlay.id}
            overlay={overlay}
            index={index}
            outputDuration={outputDuration}
            outputTime={outputTime}
            onUpdate={(patch) => updateOverlay(overlay.id, patch)}
            onRemove={() =>
              onChange((current) => ({
                ...current,
                textOverlays: current.textOverlays.filter((item) => item.id !== overlay.id),
              }))
            }
          />
        ))}
        <OutlinedActionButton
          justifyContent="center"
          startIcon={<Plus size={16} />}
          onClick={onAddText}
          disabled={outputDuration <= 0}
        >
          Add text at playhead
        </OutlinedActionButton>
      </Section>
    </VStack>
  );
};
