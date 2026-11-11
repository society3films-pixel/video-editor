import React, { useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Languages, Smile } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import { clipperTheme } from "../shared/theme.util";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import type { ClipCaptionStyle, ClipEdit } from "./clip-edit.util";
import {
  CAPTION_ACTIVE_EFFECTS,
  CAPTION_ENTRANCES,
  CAPTION_FONT_FAMILIES,
  CLIPPER_CAPTION_PRESETS,
  DEFAULT_CAPTION_PRESET_ID,
  resolveCaptionPreset,
  type CaptionActiveEffect,
  type CaptionEntrance,
  type CaptionFontFamily,
  type CaptionStyleCustom,
  type ClipperCaptionPresetId,
} from "../lib/captions/caption-presets.util";

const EFFECT_LABEL: Partial<Record<CaptionActiveEffect, string>> = {
  none: "plain",
  color: "colour",
  "gradient-pill": "pill",
  glow: "glow",
  pop: "pop",
  "beast-pop": "big pop",
  hustle: "thick outline",
};
const ENTRANCE_LABEL: Partial<Record<CaptionEntrance, string>> = {
  none: "instant",
  "page-fade": "fade",
  "group-fade": "line fade",
  "word-blur": "blur in",
  "word-scale": "pop in",
  "word-rise": "rise",
};

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
  return (
    <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label || "Colour"}
        style={{ width: 26, height: 20, padding: 0, border: "none", background: "transparent" }}
      />
      {label}
    </label>
  );
}
import { Section, SliderRow, fieldStyle } from "./clipper-editor-side-panel.component";
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
  const style = edit.captionStyle ?? null;
  const base = resolveCaptionPreset(style?.presetId ?? DEFAULT_CAPTION_PRESET_ID);
  const custom: CaptionStyleCustom = style?.custom ?? {};
  const setCustom = (patch: CaptionStyleCustom) =>
    onChange((current) =>
      current.captionStyle ? { ...current, captionStyle: { ...current.captionStyle, custom: { ...current.captionStyle.custom, ...patch } } } : current,
    );
  const setStyle = (patch: Partial<ClipCaptionStyle> | null) =>
    onChange((current) => ({
      ...current,
      captionStyle: patch === null ? null : { presetId: DEFAULT_CAPTION_PRESET_ID, position: "bottom", size: "medium", ...current.captionStyle, ...patch },
    }));
  return (
    <VStack align="stretch" gap={3}>
      <Section title="Caption style">
        <select
          value={style?.presetId ?? ""}
          onChange={(e) => setStyle(e.target.value ? { presetId: e.target.value as ClipperCaptionPresetId } : null)}
          style={fieldStyle}
          aria-label="Caption style for this clip"
        >
          <option value="">Project style</option>
          {CLIPPER_CAPTION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        {style ? (
          <HStack gap={2}>
            <select value={style.position} onChange={(e) => setStyle({ position: e.target.value as ClipCaptionStyle["position"] })} style={{ ...fieldStyle, width: "auto" }} aria-label="Caption position">
              <option value="top">Top</option>
              <option value="center">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
            <select value={style.size} onChange={(e) => setStyle({ size: e.target.value as ClipCaptionStyle["size"] })} style={{ ...fieldStyle, width: "auto" }} aria-label="Caption size">
              <option value="extra-small">Extra small</option>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </HStack>
        ) : null}
        {style ? (
          <VStack align="stretch" gap={2} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)">
            <HStack justify="space-between">
              <Text fontSize="xs" fontWeight="semibold">
                Design
              </Text>
              {style.custom && Object.keys(style.custom).length ? (
                <Box as="button" fontSize="xs" color={theme.text.muted} cursor="pointer" onClick={() => setStyle({ custom: undefined })}>
                  Reset to the style
                </Box>
              ) : null}
            </HStack>
            <HStack gap={2}>
              <select value={custom.fontFamily ?? base.fontFamily} onChange={(e) => setCustom({ fontFamily: e.target.value as CaptionFontFamily })} style={fieldStyle} aria-label="Font">
                {CAPTION_FONT_FAMILIES.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
              <select
                value={custom.fontWeight ?? base.fontWeight}
                onChange={(e) => setCustom({ fontWeight: Number(e.target.value) as CaptionStyleCustom["fontWeight"] })}
                style={{ ...fieldStyle, width: "auto" }}
                aria-label="Font weight"
              >
                {[400, 600, 700, 800, 900].map((weight) => (
                  <option key={weight} value={weight}>
                    {weight === 400 ? "Regular" : weight === 600 ? "Semibold" : weight === 700 ? "Bold" : weight === 800 ? "Extra bold" : "Black"}
                  </option>
                ))}
              </select>
            </HStack>
            <HStack gap={3} flexWrap="wrap">
              <ColorField label="Text" value={custom.textColor ?? base.textColor} onChange={(textColor) => setCustom({ textColor })} />
              <ColorField label="Spoken word" value={custom.activeTextColor ?? base.activeTextColor} onChange={(activeTextColor) => setCustom({ activeTextColor })} />
              <ColorField label="Highlight" value={custom.activeColor ?? base.activeColor} onChange={(activeColor) => setCustom({ activeColor })} />
              <ColorField label="Outline" value={custom.outlineColor ?? base.outlineColor} onChange={(outlineColor) => setCustom({ outlineColor })} />
            </HStack>
            <SliderRow
              label="Outline"
              value={custom.outlineWidthEm ?? base.outlineWidthEm}
              min={0}
              max={0.3}
              step={0.01}
              display={(custom.outlineWidthEm ?? base.outlineWidthEm).toFixed(2)}
              onChange={(outlineWidthEm) => setCustom({ outlineWidthEm })}
            />
            <HStack gap={2}>
              <select value={custom.activeEffect ?? base.activeEffect} onChange={(e) => setCustom({ activeEffect: e.target.value as CaptionActiveEffect })} style={fieldStyle} aria-label="Spoken word effect">
                {CAPTION_ACTIVE_EFFECTS.map((effect) => (
                  <option key={effect} value={effect}>
                    Spoken word: {EFFECT_LABEL[effect] ?? effect}
                  </option>
                ))}
              </select>
              <select value={custom.entrance ?? base.entrance} onChange={(e) => setCustom({ entrance: e.target.value as CaptionEntrance })} style={fieldStyle} aria-label="Entrance animation">
                {CAPTION_ENTRANCES.map((entrance) => (
                  <option key={entrance} value={entrance}>
                    In: {ENTRANCE_LABEL[entrance] ?? entrance}
                  </option>
                ))}
              </select>
            </HStack>
            <HStack gap={3}>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={custom.uppercase ?? base.uppercase}
                  onChange={(e) => setCustom({ uppercase: e.target.checked })}
                  style={{ accentColor: clipperTheme.accent }}
                />
                CAPITALS
              </label>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={(custom.plateStyle ?? base.plateStyle) === "group"}
                  onChange={(e) => setCustom({ plateStyle: e.target.checked ? "group" : "none" })}
                  style={{ accentColor: clipperTheme.accent }}
                />
                Background box
              </label>
              {(custom.plateStyle ?? base.plateStyle) === "group" ? (
                <ColorField label="" value={custom.plateColor ?? base.plateColor} onChange={(plateColor) => setCustom({ plateColor })} />
              ) : null}
            </HStack>
          </VStack>
        ) : null}
        <Text fontSize="xs" color={theme.text.muted}>
          Only this clip; the project's style stays as it is. Save it as a template to reuse it.
        </Text>
      </Section>

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
