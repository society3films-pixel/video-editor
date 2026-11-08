import React from "react";
import { Box, Flex, HStack, Text, VStack } from "@chakra-ui/react";
import { Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
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
}) => {
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
