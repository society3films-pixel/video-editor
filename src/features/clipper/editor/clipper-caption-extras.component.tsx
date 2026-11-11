import React, { useState } from "react";
import { HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Languages, Smile } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import type { ClipEdit } from "./clip-edit.util";
import { Section, fieldStyle } from "./clipper-editor-side-panel.component";
import {
  addEmojiAutomatically,
  clearEmoji,
  countEmoji,
  isSwearWord,
  maskSwearWords,
  setLineEmoji,
  swearBleepRanges,
  translateCaptions,
  TRANSLATION_LANGUAGES,
} from "./caption-extras.util";
import { describeAiChoice, resolveAiChoice } from "./ai-editor/ai-choice.util";

interface CaptionExtrasProps {
  edit: ClipEdit;
  groups: CaptionGroup[];
  /** The clip's transcript words (clip-local), for bleeps. */
  words: readonly WordCue[];
  /** Index of the line at the playhead, or -1. */
  activeLine: number;
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
}

const checkboxLabel: React.CSSProperties = { fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" };

export const ClipperCaptionExtras: React.FC<CaptionExtrasProps> = ({ edit, groups, words, activeLine, onChange }) => {
  const { theme } = useClipperUi();
  const [language, setLanguage] = useState<string>(TRANSLATION_LANGUAGES[0]);
  const [translating, setTranslating] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const setGroups = (next: (current: CaptionGroup[]) => CaptionGroup[]) =>
    onChange((current) => ({ ...current, captionGroups: next(current.captionGroups ?? groups) }));

  const emojiLines = countEmoji(groups);
  const activeEmoji = activeLine >= 0 ? groups[activeLine]?.words.find((w) => w.emoji)?.emoji ?? "" : "";
  const swearsInCaptions = groups.reduce((sum, group) => sum + group.words.filter((word) => isSwearWord(word.text)).length, 0);
  const bleepable = swearBleepRanges(words);
  const bleeping = Boolean(edit.bleeps?.length);

  const translate = async () => {
    setMessage(null);
    setTranslating(true);
    try {
      const choice = await resolveAiChoice();
      const translated = await translateCaptions(choice, groups, language);
      onChange((current) => ({ ...current, captionGroups: translated }));
      setMessage({ text: `Translated ${groups.length} lines to ${language} with ${describeAiChoice(choice)}. Undo to go back.` });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setTranslating(false);
    }
  };

  if (!groups.length) return null;
  return (
    <VStack align="stretch" gap={3}>
      <Section title="Emoji">
        <Text fontSize="xs" color={theme.text.muted}>
          An emoji pops in above a line when its word is spoken.{emojiLines ? ` ${emojiLines} line${emojiLines === 1 ? "" : "s"} have one.` : ""}
        </Text>
        <HStack gap={2}>
          <OutlinedActionButton
            h="28px"
            px={2}
            fontSize="xs"
            startIcon={<Smile size={13} />}
            onClick={() => {
              const result = addEmojiAutomatically(groups);
              onChange((current) => ({ ...current, captionGroups: result.groups }));
              setMessage({ text: result.count ? `Added emoji to ${result.count} lines.` : "No words with a matching emoji." });
            }}
          >
            Add automatically
          </OutlinedActionButton>
          {emojiLines ? (
            <OutlinedActionButton h="28px" px={2} fontSize="xs" onClick={() => setGroups(clearEmoji)}>
              Clear
            </OutlinedActionButton>
          ) : null}
        </HStack>
        {activeLine >= 0 ? (
          <label style={checkboxLabel}>
            Current line
            <input
              value={activeEmoji}
              onChange={(e) => {
                const value = [...e.target.value].slice(-2).join("").trim();
                setGroups((current) => setLineEmoji(current, activeLine, value || null));
              }}
              placeholder="Paste or type an emoji"
              aria-label="Emoji for the current line"
              style={{ ...fieldStyle, width: 150, padding: "2px 6px" }}
            />
          </label>
        ) : null}
      </Section>

      <Section title="Translate">
        <HStack gap={2}>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ ...fieldStyle, width: "auto" }} aria-label="Language">
            {TRANSLATION_LANGUAGES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <OutlinedActionButton h="32px" px={3} fontSize="xs" startIcon={translating ? <Spinner size="xs" /> : <Languages size={13} />} onClick={() => void translate()} disabled={translating}>
            {translating ? "Translating…" : "Translate captions"}
          </OutlinedActionButton>
        </HStack>
        <Text fontSize="xs" color={theme.text.muted}>
          Uses your AI (Claude or a local model), keeping each line's timing. Save once per language to get one video
          per language.
        </Text>
      </Section>

      <Section title="Swear words">
        <HStack gap={2} flexWrap="wrap">
          <OutlinedActionButton
            h="28px"
            px={2}
            fontSize="xs"
            disabled={swearsInCaptions === 0}
            onClick={() => {
              const result = maskSwearWords(groups);
              onChange((current) => ({ ...current, captionGroups: result.groups }));
            }}
          >
            {swearsInCaptions ? `Mask ${swearsInCaptions} in captions (f**k)` : "Nothing to mask in captions"}
          </OutlinedActionButton>
        </HStack>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={bleeping}
            disabled={!bleeping && bleepable.length === 0}
            onChange={(e) => onChange((current) => ({ ...current, bleeps: e.target.checked ? swearBleepRanges(words) : [] }))}
            style={{ accentColor: clipperTheme.accent }}
          />
          {bleepable.length ? `Bleep ${bleepable.length} swear word${bleepable.length === 1 ? "" : "s"} in the audio` : "No swear words heard"}
        </label>
      </Section>

      {message ? (
        <Text fontSize="xs" color={message.error ? theme.status.danger : theme.text.muted}>
          {message.text}
        </Text>
      ) : null}
    </VStack>
  );
};
