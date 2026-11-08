import React, { useCallback, useRef } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import { formatEditorTime, type ClipEditSegment } from "./clip-edit.util";

interface ClipperEditorTimelineProps {
  duration: number;
  segments: ClipEditSegment[];
  selectedSegmentId: string | null;
  currentTime: number;
  onSeek: (sourceTime: number) => void;
  onSelectSegment: (segmentId: string) => void;
  /** Called once when an edge drag starts, so the caller can snapshot undo history. */
  onTrimStart: () => void;
  onTrim: (segmentId: string, edge: "start" | "end", sourceTime: number) => void;
  /** Shot changes (dashed lines). */
  shotBoundaries?: number[];
  /** Framing keyframes (diamonds in a lane under the track). */
  keyframes?: Array<{ id: string; t: number }>;
  /** False hides the part blocks' trim handles (framing-only editing). */
  editableParts?: boolean;
}

const HANDLE_WIDTH = 10;

function tickStep(duration: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => duration / step <= 12) ?? 600;
}

export const ClipperEditorTimeline: React.FC<ClipperEditorTimelineProps> = ({
  duration,
  segments,
  selectedSegmentId,
  currentTime,
  onSeek,
  onSelectSegment,
  onTrimStart,
  onTrim,
  shotBoundaries = [],
  keyframes = [],
  editableParts = true,
}) => {
  const { theme } = useClipperUi();
  const trackRef = useRef<HTMLDivElement>(null);

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || duration <= 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  const handleTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const time = timeFromClientX(event.clientX);
      onSeek(time);
      const segment = segments.find((item) => time >= item.start && time < item.end);
      if (segment) onSelectSegment(segment.id);

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const onMove = (moveEvent: PointerEvent) => onSeek(timeFromClientX(moveEvent.clientX));
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [onSeek, onSelectSegment, segments, timeFromClientX],
  );

  const handleEdgePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, segmentId: string, edge: "start" | "end") => {
      if (event.button !== 0) return;
      event.stopPropagation();
      onTrimStart();
      onSelectSegment(segmentId);
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const onMove = (moveEvent: PointerEvent) => {
        const time = timeFromClientX(moveEvent.clientX);
        onTrim(segmentId, edge, time);
        onSeek(time);
      };
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [onSeek, onSelectSegment, onTrim, onTrimStart, timeFromClientX],
  );

  const pct = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);
  const step = tickStep(duration);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) ticks.push(t);

  return (
    <Box userSelect="none">
      <Box position="relative" h="18px" mb={1}>
        {ticks.map((tick) => (
          <Text
            key={tick}
            position="absolute"
            left={`${pct(tick)}%`}
            transform={tick === 0 ? "none" : "translateX(-50%)"}
            fontSize="10px"
            color={theme.text.muted}
            whiteSpace="nowrap"
          >
            {formatEditorTime(tick).replace(/\.0$/, "")}
          </Text>
        ))}
      </Box>

      <Box
        ref={trackRef}
        position="relative"
        h="64px"
        borderRadius="md"
        cursor="pointer"
        onPointerDown={handleTrackPointerDown}
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0 6px, rgba(0,0,0,0) 6px 12px)",
          backgroundColor: "rgba(0,0,0,0.35)",
        }}
        border="1px solid"
        borderColor={theme.surface.hover}
        aria-label="Timeline"
      >
        {segments.map((segment, index) => {
          const selected = segment.id === selectedSegmentId;
          return (
            <Box
              key={segment.id}
              position="absolute"
              top="4px"
              bottom="4px"
              left={`${pct(segment.start)}%`}
              width={`${pct(segment.end - segment.start)}%`}
              borderRadius="sm"
              bg={selected ? `rgba(${clipperTheme.accentTintRgb},0.55)` : `rgba(${clipperTheme.accentTintRgb},0.3)`}
              border="2px solid"
              borderColor={selected ? clipperTheme.accentGlow : `rgba(${clipperTheme.accentTintRgb},0.6)`}
              overflow="visible"
            >
              <Text
                position="absolute"
                left="14px"
                top="4px"
                fontSize="10px"
                fontWeight="semibold"
                color="white"
                pointerEvents="none"
                whiteSpace="nowrap"
                overflow="hidden"
                maxW="calc(100% - 28px)"
              >
                {editableParts ? `Part ${index + 1} · ${formatEditorTime(segment.end - segment.start)}` : ""}
              </Text>
              {(editableParts ? (["start", "end"] as const) : []).map((edge) => (
                <Flex
                  key={edge}
                  position="absolute"
                  top={0}
                  bottom={0}
                  {...(edge === "start" ? { left: 0 } : { right: 0 })}
                  w={`${HANDLE_WIDTH}px`}
                  align="center"
                  justify="center"
                  cursor="ew-resize"
                  bg={selected ? clipperTheme.accentGlow : `rgba(${clipperTheme.accentTintRgb},0.7)`}
                  onPointerDown={(event) => handleEdgePointerDown(event, segment.id, edge)}
                  aria-label={`Drag to trim ${edge} of part ${index + 1}`}
                >
                  <Box w="2px" h="18px" bg="whiteAlpha.800" borderRadius="full" />
                </Flex>
              ))}
            </Box>
          );
        })}

        {shotBoundaries.map((t) => (
          <Box
            key={`shot-${t}`}
            position="absolute"
            top={0}
            bottom={0}
            left={`${pct(t)}%`}
            w="0"
            borderLeft="2px dashed"
            borderColor="whiteAlpha.700"
            pointerEvents="none"
            title="Shot change"
          />
        ))}

        <Box
          position="absolute"
          top="-6px"
          bottom="-6px"
          left={`${pct(currentTime)}%`}
          w="2px"
          ml="-1px"
          bg="white"
          boxShadow="0 0 6px rgba(0,0,0,0.8)"
          pointerEvents="none"
        >
          <Box position="absolute" top="-2px" left="-5px" w="12px" h="12px" bg="white" borderRadius="full" />
        </Box>
      </Box>

      {keyframes.length > 0 || shotBoundaries.length > 0 ? (
        <Box position="relative" h="18px" mt={1}>
          {keyframes.map((keyframe) => (
            <Box
              key={keyframe.id}
              as="button"
              position="absolute"
              left={`${pct(keyframe.t)}%`}
              top="3px"
              w="11px"
              h="11px"
              ml="-5.5px"
              transform="rotate(45deg)"
              bg={clipperTheme.accentGlow}
              border="1px solid white"
              cursor="pointer"
              title={`Framing keyframe at ${formatEditorTime(keyframe.t)}`}
              aria-label={`Framing keyframe at ${formatEditorTime(keyframe.t)}`}
              onClick={() => onSeek(keyframe.t)}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
};
