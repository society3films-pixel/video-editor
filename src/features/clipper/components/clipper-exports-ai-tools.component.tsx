import React, { useEffect, useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { PenLine, TrendingUp } from "lucide-react";
import { loadScores, scoreExport, type ViralityScore } from "../editor/ai-editor/ai-virality.util";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { ClipperFormatResult } from "../shared/state.util";
import { patchClipperExportSocial } from "../persistence/clipper-export-db-api.util";
import { describeAiChoice, resolveAiChoice } from "../editor/ai-editor/ai-choice.util";
import { needsSocialMetadata, socialPatchFor, writeSocialMetadata } from "../editor/ai-editor/ai-social-metadata.util";

interface ClipperExportsAiToolsProps {
  exports: ClipperFormatResult[];
  onChanged: () => void;
  /** Extra tools rendered in the same bar (batch editing). */
  children?: React.ReactNode;
}

/** AI actions that work across all of a project's exports. */
export const ClipperExportsAiTools: React.FC<ClipperExportsAiToolsProps> = ({ exports, onChanged, children }) => {
  const { theme } = useClipperUi();
  const [overwrite, setOverwrite] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const [scores, setScores] = useState<Map<string, ViralityScore>>(new Map());
  const [scoring, setScoring] = useState<{ done: number; total: number } | null>(null);
  const exportIdsKey = exports.map((item) => item.id).join(",");
  useEffect(() => {
    void loadScores(exportIdsKey ? exportIdsKey.split(",") : []).then(setScores);
  }, [exportIdsKey]);
  const scoreAll = async () => {
    setMessage(null);
    let choice;
    try {
      choice = await resolveAiChoice();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
      return;
    }
    // One score per clip: the newest export of each clip is enough (formats share a transcript).
    const seen = new Set<string>();
    const targets = available.filter((item) => {
      const key = `${item.clipStartSec ?? item.clipIndex}-${item.clipEndSec ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const next = new Map(scores);
    const failures: string[] = [];
    setScoring({ done: 0, total: targets.length });
    for (const [index, item] of targets.entries()) {
      try {
        next.set(item.id, await scoreExport(choice, item));
        setScores(new Map(next));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      setScoring({ done: index + 1, total: targets.length });
    }
    setScoring(null);
    if (failures.length) setMessage({ text: `${failures.length} couldn't be scored: ${failures[0]}`, error: true });
  };

  const available = exports.filter((item) => !item.isMissing && (item.transcriptPlain?.trim() || item.transcriptTimestamped?.trim()));
  const targets = overwrite ? available : available.filter(needsSocialMetadata);

  const writeAll = async () => {
    setMessage(null);
    let choice;
    try {
      choice = await resolveAiChoice();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
      return;
    }
    const failures: string[] = [];
    setProgress({ done: 0, total: targets.length });
    for (const [index, item] of targets.entries()) {
      try {
        const draft = await writeSocialMetadata(choice, item);
        const patch = socialPatchFor(item, draft, overwrite);
        if (Object.keys(patch).length) await patchClipperExportSocial(item.id, patch, "overwrite");
      } catch (error) {
        failures.push(`${item.label} clip ${item.clipIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      setProgress({ done: index + 1, total: targets.length });
    }
    setProgress(null);
    onChanged();
    const written = targets.length - failures.length;
    setMessage({
      text: failures.length
        ? `Wrote metadata for ${written} of ${targets.length} with ${describeAiChoice(choice)}. Failed: ${failures.slice(0, 3).join("; ")}`
        : `Wrote titles, descriptions and hashtags for ${written} export${written === 1 ? "" : "s"} with ${describeAiChoice(choice)}.`,
      error: failures.length > 0,
    });
  };

  return (
    <Box p={4} borderRadius="xl" border="1px solid" borderColor={theme.surface.hover} bg={theme.surface.faint}>
      <VStack align="stretch" gap={3}>
        <Text fontSize="sm" fontWeight="semibold">
          AI tools
        </Text>
        <HStack gap={3} flexWrap="wrap">
          <OutlinedActionButton
            startIcon={progress ? <Spinner size="xs" /> : <PenLine size={16} />}
            onClick={() => void writeAll()}
            disabled={Boolean(progress) || targets.length === 0}
            title="Writes a hook title, descriptions and hashtags from each clip's transcript"
          >
            {progress ? `Writing ${progress.done}/${progress.total}…` : "Write titles & hashtags"}
          </OutlinedActionButton>
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} style={{ accentColor: clipperTheme.accent }} />
            Rewrite ones that are already filled
          </label>
          <Text fontSize="xs" color={theme.text.muted}>
            {targets.length === 0
              ? overwrite
                ? "No exports with a transcript."
                : "Every export already has a title, description and hashtags."
              : `${targets.length} export${targets.length === 1 ? "" : "s"} to write.`}
          </Text>
        </HStack>
        <HStack gap={3} flexWrap="wrap">
          <OutlinedActionButton
            startIcon={scoring ? <Spinner size="xs" /> : <TrendingUp size={16} />}
            onClick={() => void scoreAll()}
            disabled={Boolean(scoring) || available.length === 0}
            title="An AI rates each clip's hook, pacing and payoff, and suggests the one fix that would help most"
          >
            {scoring ? `Scoring ${scoring.done}/${scoring.total}…` : scores.size ? "Score again" : "Score clips"}
          </OutlinedActionButton>
          {scores.size ? (
            <Text fontSize="xs" color={theme.text.muted}>
              Best first. Scores are an AI's opinion from the transcript, not a prediction.
            </Text>
          ) : null}
        </HStack>
        {scores.size ? (
          <VStack align="stretch" gap={1} maxH="260px" overflowY="auto">
            {[...available]
              .filter((item) => scores.has(item.id))
              .sort((a, b) => scores.get(b.id)!.score - scores.get(a.id)!.score)
              .map((item) => {
                const s = scores.get(item.id)!;
                return (
                  <HStack key={item.id} gap={3} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)" align="start">
                    <Text fontSize="lg" fontWeight="bold" minW="34px" color={s.score >= 7 ? theme.status.success : s.score >= 5 ? theme.text.primary : theme.status.warning}>
                      {s.score}
                    </Text>
                    <VStack align="stretch" gap={0} flex={1}>
                      <Text fontSize="xs" fontWeight="semibold">
                        {item.socialTitle || `Clip ${item.clipIndex + 1}`} · {item.label} · hook {s.hook}, pacing {s.pacing}, payoff {s.payoff}
                      </Text>
                      {s.tip ? (
                        <Text fontSize="xs" color={theme.text.muted}>
                          {s.tip}
                        </Text>
                      ) : null}
                    </VStack>
                  </HStack>
                );
              })}
          </VStack>
        ) : null}
        {children}
        {message ? (
          <Text fontSize="xs" color={message.error ? theme.status.danger : theme.text.muted}>
            {message.text}
          </Text>
        ) : null}
      </VStack>
    </Box>
  );
};
