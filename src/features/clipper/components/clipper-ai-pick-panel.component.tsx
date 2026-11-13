import React, { useEffect, useState } from "react";
import { Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { WordCue } from "../lib/media/transcription-export.util";
import { fetchClipperClips, saveClipperClips } from "../persistence/clipper-clips-api.util";
import { describeAiChoice, resolveAiChoice, type AiChoice } from "../editor/ai-editor/ai-choice.util";
import { clipPicksToPayload, pickClipsWithAi, type PickedClip } from "../editor/ai-editor/ai-clip-pick.util";
import { writeYoutubeChapters } from "../editor/chapters.util";
import { findPerformanceMomentsInFile, momentsToClips } from "../editor/performance-moments.util";
import { buildPaperEdit, paperEditToClip, type PaperEdit } from "../editor/ai-editor/ai-paper-edit.util";

interface ClipperAiPickPanelProps {
  projectId: string;
  rangeWords: readonly WordCue[];
  getRangeFile?: () => File | null;
}

const inputStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.35)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  padding: "4px 6px",
  fontSize: 13,
};

/** "Pick clips with AI": the chosen model reads the transcript and saves the best moments as AI clips. */
export const ClipperAiPickPanel: React.FC<ClipperAiPickPanelProps> = ({ projectId, rangeWords, getRangeFile }) => {
  const [perfBusy, setPerfBusy] = useState(false);
  const [perfNote, setPerfNote] = useState<string | null>(null);
  const findPerformances = async () => {
    const file = getRangeFile?.();
    if (!file) {
      setPerfNote("The video isn't ready yet.");
      return;
    }
    setPerfBusy(true);
    setPerfNote(null);
    try {
      const moments = await findPerformanceMomentsInFile(file, rangeWords, { count: 10 });
      if (!moments.length) throw new Error("No songs or instrumental parts found in this video.");
      const existing = await fetchClipperClips(projectId, "ai");
      const first = existing.reduce((max, clip) => Math.max(max, clip.index + 1), 0);
      await saveClipperClips(projectId, "ai", [...existing, ...momentsToClips(moments, first)]);
      const highlights = moments.filter((m) => m.kind === "highlight").length;
      setPerfNote(`Added ${highlights} performance highlight${highlights === 1 ? "" : "s"} and ${moments.length - highlights} explain-then-play clip${moments.length - highlights === 1 ? "" : "s"} to the AI clips.`);
    } catch (reason) {
      setPerfNote(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPerfBusy(false);
    }
  };
  const { theme } = useClipperUi();
  const [open, setOpen] = useState(true);
  const [choice, setChoice] = useState<AiChoice | null>(null);
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [count, setCount] = useState(5);
  const [minSec, setMinSec] = useState(20);
  const [maxSec, setMaxSec] = useState(60);
  const [focus, setFocus] = useState("");
  const [replace, setReplace] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ clips: PickedClip[]; rejected: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    resolveAiChoice()
      .then(setChoice)
      .catch((reason: unknown) => setChoiceError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const [chapters, setChapters] = useState<string | null>(null);
  const [chaptering, setChaptering] = useState(false);
  const [longMinutes, setLongMinutes] = useState(12);
  const [longBusy, setLongBusy] = useState(false);
  const [longResult, setLongResult] = useState<PaperEdit | null>(null);
  const makeLongForm = async () => {
    if (!choice) return;
    setLongBusy(true);
    setError(null);
    try {
      const paper = await buildPaperEdit(choice, rangeWords, longMinutes, focus);
      const existing = await fetchClipperClips(projectId, "ai");
      const index = existing.reduce((max, clip) => Math.max(max, clip.index + 1), 0);
      await saveClipperClips(projectId, "ai", [...existing, paperEditToClip(paper, index)]);
      setLongResult(paper);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLongBusy(false);
    }
  };

  const makeChapters = async () => {
    if (!choice) return;
    setChaptering(true);
    setError(null);
    try {
      setChapters(await writeYoutubeChapters(choice, rangeWords));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChaptering(false);
    }
  };

  const pick = async () => {
    if (!choice) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const options = { count, minSec: Math.min(minSec, maxSec), maxSec: Math.max(minSec, maxSec), focus };
      const picked = await pickClipsWithAi(choice, rangeWords, options);
      if (picked.clips.length === 0) throw new Error("The AI didn't find clips that fit those lengths. Try a wider range.");
      const existing = replace ? [] : await fetchClipperClips(projectId, "ai");
      const firstIndex = existing.reduce((max, clip) => Math.max(max, clip.index + 1), 0);
      // Preview reloads AI clips from storage automatically (the same path MCP agents use).
      await saveClipperClips(projectId, "ai", [...existing, ...clipPicksToPayload(picked.clips, rangeWords, firstIndex)]);
      setResult(picked);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Box flexShrink={0} px={4} py={3} borderTop="1px solid" borderColor={theme.border.primary}>
      <HStack as="button" w="full" justify="space-between" cursor="pointer" onClick={() => setOpen((value) => !value)}>
        <HStack gap={2}>
          <Sparkles size={15} color={clipperTheme.accentGlow} />
          <Text fontSize="sm" fontWeight="semibold" color={theme.text.primary}>
            Pick clips with AI
          </Text>
        </HStack>
        {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </HStack>
      {open ? (
        <VStack align="stretch" gap={2} mt={2}>
          <Text fontSize="xs" color={theme.text.muted}>
            {choice
              ? `${describeAiChoice(choice)} reads the transcript and picks the best moments. Change the model in any clip editor's AI tab.`
              : choiceError ?? "Checking your AI setup…"}
          </Text>
          <HStack gap={2} flexWrap="wrap" fontSize="xs" color={theme.text.muted}>
            <label>
              Clips{" "}
              <input type="number" min={1} max={15} value={count} onChange={(e) => setCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))} style={{ ...inputStyle, width: 52 }} />
            </label>
            <label>
              Length{" "}
              <input type="number" min={5} max={180} value={minSec} onChange={(e) => setMinSec(Number(e.target.value) || 5)} style={{ ...inputStyle, width: 56 }} />
              {" – "}
              <input type="number" min={5} max={180} value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value) || 60)} style={{ ...inputStyle, width: 56 }} /> s
            </label>
          </HStack>
          <input
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="Optional focus, e.g. funny moments, advice about pricing"
            style={{ ...inputStyle, width: "100%" }}
            aria-label="What to look for"
          />
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} style={{ accentColor: clipperTheme.accent }} />
            Replace the current AI clips
          </label>
          <Button
            size="sm"
            bg={clipperTheme.accent}
            color="white"
            _hover={{ bg: clipperTheme.accentHover }}
            onClick={() => void pick()}
            disabled={!choice || running || rangeWords.length < 20}
          >
            {running ? (
              <HStack gap={2}>
                <Spinner size="xs" />
                <Text>Reading the transcript…</Text>
              </HStack>
            ) : (
              "Pick clips"
            )}
          </Button>
          {error ? (
            <Text fontSize="xs" color={theme.status.danger}>
              {error}
            </Text>
          ) : null}
          <VStack align="stretch" gap={1} pt={2} borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
            <Text fontSize="xs" fontWeight="semibold">
              Performances
            </Text>
            <Text fontSize="xs" color={theme.text.muted}>
              Finds the songs in the video and adds the strongest 20-40 s of each (ending between phrases, ranked by the
              crowd's reaction), plus clips where they explain something and then play it. Works offline.
            </Text>
            <Button size="xs" variant="outline" alignSelf="flex-start" onClick={() => void findPerformances()} disabled={perfBusy || !getRangeFile}>
              {perfBusy ? <Spinner size="xs" /> : null} Find performance moments
            </Button>
            {perfNote ? (
              <Text fontSize="xs" color={theme.text.muted}>
                {perfNote}
              </Text>
            ) : null}
          </VStack>
          <VStack align="stretch" gap={1} pt={2} borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
            <Text fontSize="xs" fontWeight="semibold">
              Long-form edit
            </Text>
            <Text fontSize="xs" color={theme.text.muted}>
              The AI builds a story from the whole interview (best answers in a flowing order, performances between
              topics) and saves it as one AI clip to render in 16:9 and fine-tune.
            </Text>
            <HStack gap={2} flexWrap="wrap" fontSize="xs" color={theme.text.muted}>
              <label>
                About{" "}
                <input type="number" min={2} max={90} value={longMinutes} onChange={(e) => setLongMinutes(Math.max(2, Math.min(90, Number(e.target.value) || 10)))} style={{ ...inputStyle, width: 56 }} /> min
              </label>
              <Button size="xs" variant="outline" onClick={() => void makeLongForm()} disabled={!choice || longBusy || rangeWords.length < 200}>
                {longBusy ? <Spinner size="xs" /> : null} Build it
              </Button>
            </HStack>
            {longResult ? (
              <Text fontSize="xs" color={theme.text.muted}>
                Saved “{longResult.title}”: {longResult.parts.length} parts, {Math.round(longResult.durationSec / 60)} min (
                {longResult.parts.filter((p) => p.kind === "music").length} performances). It's in the AI clips list.
              </Text>
            ) : null}
          </VStack>
          <HStack gap={2} pt={1} borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
            <Button size="xs" variant="outline" onClick={() => void makeChapters()} disabled={!choice || chaptering || rangeWords.length < 100}>
              {chaptering ? <Spinner size="xs" /> : null} YouTube chapters
            </Button>
            <Text fontSize="xs" color={theme.text.muted}>
              Timestamps for the long video's description (from the start of the selected range).
            </Text>
          </HStack>
          {chapters ? (
            <VStack align="stretch" gap={1}>
              <textarea readOnly value={chapters} rows={Math.min(12, chapters.split("\n").length + 1)} style={{ ...inputStyle, fontFamily: "monospace", width: "100%" }} aria-label="YouTube chapters" />
              <Button size="xs" alignSelf="flex-start" variant="outline" onClick={() => void navigator.clipboard?.writeText(chapters)}>
                Copy
              </Button>
            </VStack>
          ) : null}
          {result ? (
            <VStack align="stretch" gap={1}>
              <Text fontSize="xs" color={theme.text.muted}>
                Added {result.clips.length} clip{result.clips.length === 1 ? "" : "s"}
                {result.rejected ? ` (${result.rejected} suggestion${result.rejected === 1 ? "" : "s"} didn't fit and were skipped)` : ""}:
              </Text>
              {result.clips.map((clip) => (
                <Text key={clip.title + clip.segments[0]!.from} fontSize="xs">
                  <b>{clip.title}</b> · {Math.round(clip.durationSec)}s{clip.reason ? `: ${clip.reason}` : ""}
                </Text>
              ))}
            </VStack>
          ) : null}
        </VStack>
      ) : null}
    </Box>
  );
};
