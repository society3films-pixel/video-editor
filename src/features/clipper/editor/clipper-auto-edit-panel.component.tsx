import React from "react";
import { Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { AutoEditOptions } from "./auto-edit.util";

interface StepInfo {
  key: keyof AutoEditOptions;
  label: string;
  description: string;
  /** Why the step can't run here; undefined = available. */
  unavailable?: string;
}

interface ClipperAutoEditPanelProps {
  options: AutoEditOptions;
  onChange: (options: AutoEditOptions) => void;
  onApply: () => void;
  onCancel: () => void;
  running: boolean;
  /** Clip mode (Fix framing) only offers the framing step. */
  framingOnly: boolean;
  hasTranscript: boolean;
  hasFaceTracking: boolean;
  hasExportAudio: boolean;
}

export const ClipperAutoEditPanel: React.FC<ClipperAutoEditPanelProps> = ({
  options,
  onChange,
  onApply,
  onCancel,
  running,
  framingOnly,
  hasTranscript,
  hasFaceTracking,
  hasExportAudio,
}) => {
  const { theme } = useClipperUi();
  const noTranscript = hasTranscript ? undefined : "Needs the project's transcript (open from a loaded project).";
  const steps: StepInfo[] = [
    {
      key: "cutPauses",
      label: "Cut pauses and filler words",
      description: "Shortens long silences and removes um, uh and similar.",
      unavailable: noTranscript,
    },
    {
      key: "protectMusic",
      label: "Protect songs and performances",
      description: "Finds where music is playing and never cuts inside it (fillers and pauses there are kept).",
      unavailable: hasExportAudio ? undefined : "Available when editing an export.",
    },
    {
      key: "tightenTurns",
      label: "Tighten conversation",
      description: "With two people, cuts the pauses where the speaker changes extra short (finds who's talking first).",
      unavailable: hasTranscript ? undefined : noTranscript,
    },
    {
      key: "fixFraming",
      label: "Fix framing",
      description: "Switches shots where two people don't fit to AI-tracked split screen, and screen recordings with a small webcam face to Screen + face.",
      unavailable: hasFaceTracking ? undefined : "Needs the project's face tracking (open from a loaded project).",
    },
    {
      key: "punchIns",
      label: "Punch-in zooms",
      description: "Zooms every other part to 115%, so jump cuts feel deliberate.",
    },
    {
      key: "hookTitle",
      label: "Hook title",
      description: "Puts the clip's title, or its first sentence, at the top for the first seconds.",
      unavailable: hasTranscript ? undefined : noTranscript,
    },
    {
      key: "highlightKeywords",
      label: "Highlight keywords",
      description: "Colours one key word in caption lines (numbers, names, strong words).",
      unavailable: hasTranscript ? undefined : noTranscript,
    },
    {
      key: "levelVolume",
      label: "Level the volume",
      description: "Measures the speech and sets a consistent loudness.",
      unavailable: hasExportAudio ? undefined : "Available when editing an export.",
    },
  ];
  const shown = framingOnly ? steps.filter((step) => step.key === "fixFraming") : steps;
  const anyEnabled = shown.some((step) => !step.unavailable && options[step.key]);

  return (
    <Box
      position="absolute"
      top="calc(100% + 8px)"
      right={0}
      zIndex={10}
      w="340px"
      p={4}
      borderRadius="lg"
      border="1px solid"
      borderColor={theme.surface.hover}
      bg={theme.background.secondary}
      boxShadow="0 12px 40px rgba(0,0,0,0.5)"
    >
      <VStack align="stretch" gap={3}>
        <VStack align="start" gap={0}>
          <Text fontSize="sm" fontWeight="bold">
            Auto edit
          </Text>
          <Text fontSize="xs" color={theme.text.muted}>
            Applies as normal edits you can review and change. Undo reverts it in one step.
          </Text>
        </VStack>
        {shown.map((step) => (
          <label
            key={step.key}
            style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: step.unavailable ? "default" : "pointer", opacity: step.unavailable ? 0.5 : 1 }}
          >
            <input
              type="checkbox"
              checked={!step.unavailable && options[step.key]}
              disabled={Boolean(step.unavailable) || running}
              onChange={(event) => onChange({ ...options, [step.key]: event.target.checked })}
              style={{ marginTop: 3, accentColor: clipperTheme.accent }}
            />
            <span>
              <Text as="span" fontSize="sm" display="block">
                {step.label}
              </Text>
              <Text as="span" fontSize="xs" color={theme.text.muted} display="block">
                {step.unavailable ?? step.description}
              </Text>
            </span>
          </label>
        ))}
        {!framingOnly && options.cutPauses && hasTranscript ? (
          <Text fontSize="xs" color={theme.text.muted}>
            Cutting pauses replaces your current cuts.
          </Text>
        ) : null}
        <HStack justify="flex-end" gap={2}>
          <Button size="sm" variant="ghost" color={theme.text.primary} onClick={onCancel} disabled={running}>
            Cancel
          </Button>
          <Button
            size="sm"
            bg={clipperTheme.accent}
            color="white"
            _hover={{ bg: clipperTheme.accentHover }}
            onClick={onApply}
            disabled={!anyEnabled || running}
          >
            {running ? (
              <HStack gap={2}>
                <Spinner size="xs" />
                <Text>Working…</Text>
              </HStack>
            ) : (
              "Apply"
            )}
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
};
