import React from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { Crosshair, Diamond, Eye, EyeOff, Plus, RotateCcw, ScissorsLineDashed, Sparkles, X } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import type { CaptionGroup } from "../lib/media/transcription-export.util";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import { captionGroupText, formatEditorTime } from "./clip-edit.util";
import type { ClipFramingKeyframe, ClipperFramingValue } from "../engine/render/framing-override.util";
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
  shot: { index: number; start: number; end: number; count: number };
  /** Framing at the playhead; undefined = AI framing. */
  value: ClipperFramingValue | undefined;
  keyframes: ClipFramingKeyframe[];
  keyframeAtPlayhead: ClipFramingKeyframe | undefined;
  /** The current shot starts at a shot change the user added (and can remove). */
  userShotStart: boolean;
  currentTime: number;
  onChange: (value: ClipperFramingValue) => void;
  onLock: () => void;
  onAddKeyframe: () => void;
  onRemoveKeyframe: (id: string) => void;
  onSeek: (localTime: number) => void;
  onResetShot: () => void;
  onApplyToAll: () => void;
  onAddShotBoundary: () => void;
  onRemoveShotBoundary: () => void;
}

const DEFAULT_VALUE: ClipperFramingValue = { mode: "auto", x: 0, y: 0, zoom: 1, singleShot: false };

export const ClipperEditorFramingPanel: React.FC<FramingPanelProps> = ({
  shot,
  value,
  keyframes,
  keyframeAtPlayhead,
  userShotStart,
  currentTime,
  onChange,
  onLock,
  onAddKeyframe,
  onRemoveKeyframe,
  onSeek,
  onResetShot,
  onApplyToAll,
  onAddShotBoundary,
  onRemoveShotBoundary,
}) => {
  const { theme } = useClipperUi();
  const current = value ?? DEFAULT_VALUE;
  const update = (patch: Partial<ClipperFramingValue>) => onChange({ ...current, ...patch });
  const animated = keyframes.length >= 2;
  const smallButton = { h: "30px", fontSize: "xs", px: 2, justifyContent: "center" } as const;

  return (
    <VStack align="stretch" gap={3}>
      <Section title={shot.count > 1 ? `Shot ${shot.index + 1} of ${shot.count}` : "Framing"}>
        <Text fontSize="xs" color={theme.text.muted}>
          {formatEditorTime(shot.start)} – {formatEditorTime(shot.end)} ·{" "}
          {keyframes.length === 0
            ? "AI framing"
            : animated
              ? `Camera moves between ${keyframes.length} keyframes`
              : "Your framing for the whole shot"}
        </Text>
        <HStack gap={2}>
          <ChoiceButton
            selected={current.mode === "auto"}
            onClick={() => current.mode !== "auto" && update({ mode: "auto", x: 0, y: 0, zoom: 1 })}
            title="Follow the AI camera, optionally nudged"
          >
            <Sparkles size={13} /> Follow AI
          </ChoiceButton>
          <ChoiceButton
            selected={current.mode === "fixed"}
            onClick={() => current.mode !== "fixed" && onLock()}
            title="Place the camera yourself"
          >
            <Crosshair size={13} /> Manual
          </ChoiceButton>
        </HStack>
        <Text fontSize="xs" color={theme.text.muted}>
          Drag the picture to reposition. Changes apply to this shot only; other shots keep their framing.
        </Text>
        <SliderRow
          label="Zoom"
          value={current.zoom}
          min={1}
          max={3}
          step={0.05}
          display={`${Math.round(current.zoom * 100)}%`}
          onChange={(zoom) => update({ zoom })}
        />
        {current.mode === "fixed" ? (
          <>
            <SliderRow label="Horizontal" value={current.x} min={0} max={1} step={0.005} display={`${Math.round(current.x * 100)}%`} onChange={(x) => update({ x })} />
            <SliderRow label="Vertical" value={current.y} min={0} max={1} step={0.005} display={`${Math.round(current.y * 100)}%`} onChange={(y) => update({ y })} />
          </>
        ) : (
          <>
            <SliderRow label="Nudge left / right" value={current.x} min={-1} max={1} step={0.01} display={`${Math.round(current.x * 100)}`} onChange={(x) => update({ x })} />
            <SliderRow label="Nudge up / down" value={current.y} min={-1} max={1} step={0.01} display={`${Math.round(current.y * 100)}`} onChange={(y) => update({ y })} />
          </>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={current.singleShot}
            onChange={(event) => update({ singleShot: event.target.checked })}
            style={{ accentColor: clipperTheme.accent }}
          />
          No split screen in this shot
        </label>
        <HStack gap={2}>
          <OutlinedActionButton flex={1} {...smallButton} startIcon={<RotateCcw size={13} />} onClick={onResetShot} disabled={keyframes.length === 0}>
            Back to AI
          </OutlinedActionButton>
          {shot.count > 1 ? (
            <OutlinedActionButton flex={1} {...smallButton} onClick={onApplyToAll} disabled={keyframes.length === 0}>
              Use for all shots
            </OutlinedActionButton>
          ) : null}
        </HStack>
      </Section>

      <Section title="Camera moves">
        <Text fontSize="xs" color={theme.text.muted}>
          To make the camera move, add a keyframe, go to another moment in the shot and change the framing.
          The camera glides between keyframes.
        </Text>
        <HStack gap={2}>
          <OutlinedActionButton
            flex={1}
            {...smallButton}
            startIcon={<Plus size={13} />}
            onClick={onAddKeyframe}
            disabled={Boolean(keyframeAtPlayhead)}
          >
            Add keyframe here
          </OutlinedActionButton>
          {keyframeAtPlayhead ? (
            <OutlinedActionButton flex={1} {...smallButton} tone="danger" onClick={() => onRemoveKeyframe(keyframeAtPlayhead.id)}>
              Remove keyframe
            </OutlinedActionButton>
          ) : null}
        </HStack>
        {keyframes.length > 0 ? (
          <VStack align="stretch" gap={1}>
            {keyframes.map((keyframe, index) => {
              const active = Math.abs(keyframe.t - currentTime) <= 0.08;
              return (
                <HStack
                  key={keyframe.id}
                  gap={2}
                  px={2}
                  py={1}
                  borderRadius="sm"
                  bg={active ? `rgba(${clipperTheme.accentTintRgb},0.18)` : "transparent"}
                >
                  <Box as="button" display="flex" alignItems="center" gap={2} flex={1} cursor="pointer" onClick={() => onSeek(keyframe.t)}>
                    <Diamond size={11} fill={active ? clipperTheme.accentGlow : "none"} color={clipperTheme.accentGlow} />
                    <Text fontSize="xs" fontFamily="mono">{formatEditorTime(keyframe.t)}</Text>
                    <Text fontSize="xs" color={theme.text.muted}>
                      {keyframe.mode === "fixed" ? "Manual" : "Follow AI"} · {Math.round(keyframe.zoom * 100)}%
                    </Text>
                  </Box>
                  <Box
                    as="button"
                    aria-label={`Remove keyframe ${index + 1}`}
                    color={theme.text.muted}
                    _hover={{ color: theme.status.danger }}
                    cursor="pointer"
                    onClick={() => onRemoveKeyframe(keyframe.id)}
                  >
                    <X size={13} />
                  </Box>
                </HStack>
              );
            })}
          </VStack>
        ) : null}
      </Section>

      <Section title="Shot changes">
        <Text fontSize="xs" color={theme.text.muted}>
          Shots are found automatically. If the AI missed a cut, add one at the playhead so each side can be framed on its own.
        </Text>
        <HStack gap={2}>
          <OutlinedActionButton flex={1} {...smallButton} startIcon={<ScissorsLineDashed size={13} />} onClick={onAddShotBoundary}>
            Add shot change here
          </OutlinedActionButton>
          {userShotStart ? (
            <OutlinedActionButton flex={1} {...smallButton} onClick={onRemoveShotBoundary}>
              Remove this shot change
            </OutlinedActionButton>
          ) : null}
        </HStack>
      </Section>
    </VStack>
  );
};
