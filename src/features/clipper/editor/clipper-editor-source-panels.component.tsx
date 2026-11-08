import React from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { Crosshair, Eye, EyeOff, RotateCcw, Sparkles } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import type { CaptionGroup } from "../lib/media/transcription-export.util";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import {
  captionGroupText,
  formatEditorTime,
  type ClipEditSegment,
  type ClipSegmentFraming,
} from "./clip-edit.util";
import { Section, SliderRow, fieldStyle } from "./clipper-editor-side-panel.component";

function ChoiceButton({
  selected,
  onClick,
  children,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const { theme } = useClipperUi();
  return (
    <Box
      as="button"
      title={title}
      flex={1}
      display="flex"
      alignItems="center"
      justifyContent="center"
      gap={1}
      fontSize="xs"
      py={1.5}
      borderRadius="sm"
      border="1px solid"
      cursor="pointer"
      borderColor={selected ? clipperTheme.accentGlow : theme.surface.hover}
      bg={selected ? `rgba(${clipperTheme.accentTintRgb},0.2)` : "transparent"}
      color={theme.text.primary}
      onClick={onClick}
    >
      {children}
    </Box>
  );
}

// ---- Captions ---------------------------------------------------------------------------------

interface CaptionsPanelProps {
  groups: CaptionGroup[];
  edited: boolean;
  visible: boolean;
  /** Clip-local playhead time, to highlight the line on screen. */
  currentTime: number;
  onToggleVisible: () => void;
  onChangeText: (index: number, text: string) => void;
  onSeek: (localTime: number) => void;
  onReset: () => void;
}

export const ClipperEditorCaptionsPanel: React.FC<CaptionsPanelProps> = ({
  groups,
  edited,
  visible,
  currentTime,
  onToggleVisible,
  onChangeText,
  onSeek,
  onReset,
}) => {
  const { theme } = useClipperUi();
  return (
    <Section title="Captions">
      <HStack gap={2}>
        <ChoiceButton selected={visible} onClick={() => !visible && onToggleVisible()}>
          <Eye size={13} /> Show
        </ChoiceButton>
        <ChoiceButton selected={!visible} onClick={() => visible && onToggleVisible()}>
          <EyeOff size={13} /> Hide
        </ChoiceButton>
      </HStack>
      {groups.length === 0 ? (
        <Text fontSize="xs" color={theme.text.muted}>
          This clip has no caption lines.
        </Text>
      ) : (
        <Text fontSize="xs" color={theme.text.muted}>
          Edit a line to change its wording. Clear a line to remove it. Click the time to jump there.
        </Text>
      )}
      <VStack align="stretch" gap={1.5} opacity={visible ? 1 : 0.5}>
        {groups.map((group, index) => {
          const active = currentTime >= group.start && currentTime < group.end;
          return (
            <HStack key={`${index}-${group.start}`} gap={2} align="center">
              <Box
                as="button"
                onClick={() => onSeek(group.start + 0.01)}
                fontSize="10px"
                fontFamily="mono"
                minW="42px"
                textAlign="left"
                color={active ? clipperTheme.accentGlow : theme.text.muted}
                cursor="pointer"
                _hover={{ color: theme.text.primary }}
              >
                {formatEditorTime(group.start)}
              </Box>
              <input
                value={captionGroupText(group)}
                onChange={(event) => onChangeText(index, event.target.value)}
                onFocus={() => onSeek(group.start + 0.01)}
                style={{
                  ...fieldStyle,
                  borderColor: active ? clipperTheme.accentGlow : "rgba(255,255,255,0.12)",
                }}
                aria-label={`Caption line ${index + 1}`}
              />
            </HStack>
          );
        })}
      </VStack>
      {edited ? (
        <OutlinedActionButton justifyContent="center" startIcon={<RotateCcw size={14} />} onClick={onReset} h="32px" fontSize="xs">
          Restore original captions
        </OutlinedActionButton>
      ) : null}
    </Section>
  );
};

// ---- Framing ----------------------------------------------------------------------------------

interface FramingPanelProps {
  segment: ClipEditSegment | null;
  segmentNumber: number;
  partCount: number;
  onChange: (framing: ClipSegmentFraming | undefined) => void;
  onLock: () => void;
  onApplyToAll: () => void;
}

export const ClipperEditorFramingPanel: React.FC<FramingPanelProps> = ({
  segment,
  segmentNumber,
  partCount,
  onChange,
  onLock,
  onApplyToAll,
}) => {
  const { theme } = useClipperUi();
  if (!segment) {
    return (
      <Section title="Framing">
        <Text fontSize="xs" color={theme.text.muted}>
          Move the playhead onto a part to adjust its framing.
        </Text>
      </Section>
    );
  }
  const framing = segment.framing;
  const update = (patch: Partial<ClipSegmentFraming>) =>
    onChange({ mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false, ...framing, ...patch });

  return (
    <Section title={partCount > 1 ? `Framing · Part ${segmentNumber}` : "Framing"}>
      <HStack gap={2}>
        <ChoiceButton
          selected={!framing || framing.mode === "auto"}
          onClick={() => update({ mode: "auto", x: 0, y: 0 })}
          title="Follow the AI camera, optionally nudged"
        >
          <Sparkles size={13} /> Follow AI
        </ChoiceButton>
        <ChoiceButton
          selected={framing?.mode === "fixed"}
          onClick={() => framing?.mode !== "fixed" && onLock()}
          title="Lock the camera where you put it"
        >
          <Crosshair size={13} /> Locked
        </ChoiceButton>
      </HStack>
      <Text fontSize="xs" color={theme.text.muted}>
        Drag the picture to reposition. {partCount > 1 ? "Split the clip to frame each shot on its own." : "Split the clip to frame different shots differently."}
      </Text>
      <SliderRow
        label="Zoom"
        value={framing?.zoom ?? 1}
        min={1}
        max={3}
        step={0.05}
        display={`${Math.round((framing?.zoom ?? 1) * 100)}%`}
        onChange={(zoom) => update({ zoom })}
      />
      {framing?.mode === "fixed" ? (
        <>
          <SliderRow
            label="Horizontal"
            value={framing.x}
            min={0}
            max={1}
            step={0.005}
            display={`${Math.round(framing.x * 100)}%`}
            onChange={(x) => update({ x })}
          />
          <SliderRow
            label="Vertical"
            value={framing.y}
            min={0}
            max={1}
            step={0.005}
            display={`${Math.round(framing.y * 100)}%`}
            onChange={(y) => update({ y })}
          />
        </>
      ) : (
        <>
          <SliderRow
            label="Nudge left / right"
            value={framing?.x ?? 0}
            min={-1}
            max={1}
            step={0.01}
            display={`${Math.round((framing?.x ?? 0) * 100)}`}
            onChange={(x) => update({ x })}
          />
          <SliderRow
            label="Nudge up / down"
            value={framing?.y ?? 0}
            min={-1}
            max={1}
            step={0.01}
            display={`${Math.round((framing?.y ?? 0) * 100)}`}
            onChange={(y) => update({ y })}
          />
        </>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={framing?.singleShot ?? false}
          onChange={(event) => update({ singleShot: event.target.checked })}
          style={{ accentColor: clipperTheme.accent }}
        />
        No split screen in this part
      </label>
      <HStack gap={2}>
        <OutlinedActionButton
          flex={1}
          justifyContent="center"
          h="32px"
          fontSize="xs"
          px={2}
          startIcon={<RotateCcw size={14} />}
          onClick={() => onChange(undefined)}
          disabled={!framing}
        >
          AI framing
        </OutlinedActionButton>
        {partCount > 1 ? (
          <OutlinedActionButton flex={1} justifyContent="center" h="32px" fontSize="xs" px={2} onClick={onApplyToAll}>
            Apply to all parts
          </OutlinedActionButton>
        ) : null}
      </HStack>
    </Section>
  );
};
