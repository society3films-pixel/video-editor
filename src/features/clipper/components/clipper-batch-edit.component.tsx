import React, { useRef, useState } from "react";
import { Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Layers } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEditorBridge } from "../editor/clip-editor-source.util";
import { DEFAULT_AUTO_EDIT_OPTIONS, type AutoEditOptions } from "../editor/auto-edit.util";
import { batchEditExport, latestExportPerClip } from "../editor/batch-edit.util";
import { describeAiChoice, resolveAiChoice } from "../editor/ai-editor/ai-choice.util";

interface ClipperBatchEditProps {
  projectId: string;
  exports: ClipperFormatResult[];
  bridge?: ClipEditorBridge;
  onChanged: () => void;
}

const STEP_LABELS: Array<[keyof AutoEditOptions, string]> = [
  ["cutPauses", "Cut pauses & fillers"],
  ["fixFraming", "Fix framing"],
  ["punchIns", "Punch-ins"],
  ["hookTitle", "Hook title"],
  ["highlightKeywords", "Highlight keywords"],
  ["levelVolume", "Level volume"],
];

/** "Edit all clips": Auto edit and/or an AI instruction on every clip, each saved as a new export. */
export const ClipperBatchEdit: React.FC<ClipperBatchEditProps> = ({ projectId, exports, bridge, onChanged }) => {
  const { theme } = useClipperUi();
  const [open, setOpen] = useState(false);
  const [useAuto, setUseAuto] = useState(true);
  const [steps, setSteps] = useState<AutoEditOptions>(DEFAULT_AUTO_EDIT_OPTIONS);
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<{ index: number; total: number; label: string; ratio: number } | null>(null);
  const [log, setLog] = useState<Array<{ text: string; error?: boolean }>>([]);
  const abortRef = useRef<AbortController | null>(null);

  const targets = latestExportPerClip(exports);
  const canRun = Boolean(bridge) && targets.length > 0 && (useAuto || instruction.trim().length > 0);

  const run = async () => {
    if (!bridge) return;
    setLog([]);
    let choice = null;
    if (instruction.trim()) {
      try {
        choice = await resolveAiChoice();
      } catch (error) {
        setLog([{ text: error instanceof Error ? error.message : String(error), error: true }]);
        return;
      }
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const entries: Array<{ text: string; error?: boolean }> = choice ? [{ text: `Using ${describeAiChoice(choice)}.` }] : [];
    try {
      for (const [index, item] of targets.entries()) {
        if (controller.signal.aborted) break;
        const label = `${item.label} · clip ${item.clipIndex + 1}`;
        setStatus({ index, total: targets.length, label, ratio: 0 });
        try {
          const outcome = await batchEditExport(
            projectId,
            item,
            exports,
            bridge,
            { auto: useAuto ? steps : null, instruction, choice },
            { signal: controller.signal, onProgress: (ratio) => setStatus({ index, total: targets.length, label, ratio }) },
          );
          entries.push(
            outcome.kind === "saved"
              ? { text: `✓ ${label}: saved ${outcome.fileName}${outcome.notes.length ? ` (${outcome.notes.length} AI change${outcome.notes.length === 1 ? "" : "s"} skipped)` : ""}` }
              : { text: `– ${label}: skipped, ${outcome.reason}` },
          );
        } catch (error) {
          if (controller.signal.aborted) break;
          entries.push({ text: `✗ ${label}: ${error instanceof Error ? error.message : String(error)}`, error: true });
        }
        setLog([...entries]);
      }
      if (controller.signal.aborted) entries.push({ text: "Stopped. Clips already saved are kept." });
      setLog([...entries]);
    } finally {
      abortRef.current = null;
      setStatus(null);
      onChanged();
    }
  };

  return (
    <VStack align="stretch" gap={2}>
      <HStack gap={3} flexWrap="wrap">
        <OutlinedActionButton startIcon={<Layers size={16} />} onClick={() => setOpen((value) => !value)} disabled={Boolean(status)}>
          Edit all clips
        </OutlinedActionButton>
        <Text fontSize="xs" color={theme.text.muted}>
          {bridge
            ? `${targets.length} clip${targets.length === 1 ? "" : "s"} (the newest version in each format), each saved as a new export.`
            : "Open the project to edit all clips."}
        </Text>
      </HStack>
      {open ? (
        <VStack align="stretch" gap={2} p={3} borderRadius="md" bg="rgba(0,0,0,0.2)">
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={useAuto} onChange={(e) => setUseAuto(e.target.checked)} style={{ accentColor: clipperTheme.accent }} />
            Auto edit
          </label>
          {useAuto ? (
            <HStack gap={3} flexWrap="wrap" pl={5}>
              {STEP_LABELS.map(([key, label]) => (
                <label key={key} style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={steps[key]}
                    onChange={(e) => setSteps({ ...steps, [key]: e.target.checked })}
                    style={{ accentColor: clipperTheme.accent }}
                  />
                  {label}
                </label>
              ))}
            </HStack>
          ) : null}
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder="Optional AI instruction for every clip, e.g. make it punchier and add a hook"
            aria-label="AI instruction for every clip"
            style={{
              background: "rgba(0,0,0,0.35)",
              color: "inherit",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 13,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <HStack gap={2}>
            <Button
              size="sm"
              bg={clipperTheme.accent}
              color="white"
              _hover={{ bg: clipperTheme.accentHover }}
              onClick={() => void run()}
              disabled={!canRun || Boolean(status)}
            >
              {status ? (
                <HStack gap={2}>
                  <Spinner size="xs" />
                  <Text>
                    {status.index + 1}/{status.total} · {Math.round(status.ratio * 100)}%
                  </Text>
                </HStack>
              ) : (
                `Edit and save ${targets.length} clip${targets.length === 1 ? "" : "s"}`
              )}
            </Button>
            {status ? (
              <OutlinedActionButton tone="danger" onClick={() => abortRef.current?.abort()} h="32px" fontSize="xs">
                Stop
              </OutlinedActionButton>
            ) : null}
          </HStack>
          {status ? (
            <Text fontSize="xs" color={theme.text.muted}>
              Working on {status.label}…
            </Text>
          ) : null}
          {log.length ? (
            <Box maxH="160px" overflowY="auto">
              {log.map((entry, index) => (
                <Text key={index} fontSize="xs" color={entry.error ? theme.status.danger : theme.text.muted}>
                  {entry.text}
                </Text>
              ))}
            </Box>
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  );
};
