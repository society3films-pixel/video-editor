import React, { useEffect, useState } from "react";
import { HStack, Text } from "@chakra-ui/react";
import { Trash2 } from "lucide-react";
import { OutlinedActionButton } from "../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../shared/use-clipper-ui.hook";
import type { CaptionGroup, WordCue } from "../lib/media/transcription-export.util";
import type { ClipEdit } from "./clip-edit.util";
import { Section, fieldStyle } from "./clipper-editor-side-panel.component";
import { applyTemplate, deleteTemplate, describeTemplate, loadTemplates, saveTemplate, templateFromEdit, type EditTemplate } from "./edit-templates.util";

/** Apply a saved look to this clip, or save this clip's look as a template. */
export const ClipperEditTemplates: React.FC<{
  edit: ClipEdit;
  captionGroups: readonly CaptionGroup[];
  words: readonly WordCue[];
  sourceDuration: number;
  onChange: (updater: (edit: ClipEdit) => ClipEdit) => void;
}> = ({ edit, captionGroups, words, sourceDuration, onChange }) => {
  const { theme } = useClipperUi();
  const [templates, setTemplates] = useState<EditTemplate[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void loadTemplates().then((list) => {
      setTemplates(list);
      setSelected((current) => current || list[0]?.id || "");
    });
  }, []);

  const template = templates.find((t) => t.id === selected);
  return (
    <Section title="Templates">
      {templates.length ? (
        <>
          <HStack gap={2}>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} style={fieldStyle} aria-label="Template">
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <OutlinedActionButton
              h="32px"
              px={3}
              fontSize="xs"
              disabled={!template}
              onClick={() => {
                if (!template) return;
                onChange((current) => applyTemplate(current, template, { captionGroups, words, duration: sourceDuration }));
                setNote(`Applied “${template.name}”. Undo to go back.`);
              }}
            >
              Apply
            </OutlinedActionButton>
            <OutlinedActionButton
              h="32px"
              px={2}
              tone="danger"
              aria-label="Delete template"
              disabled={!template}
              onClick={() => template && void deleteTemplate(template.id).then((list) => (setTemplates(list), setSelected(list[0]?.id ?? "")))}
            >
              <Trash2 size={13} />
            </OutlinedActionButton>
          </HStack>
          {template ? (
            <Text fontSize="xs" color={theme.text.muted}>
              {describeTemplate(template)}
            </Text>
          ) : null}
        </>
      ) : (
        <Text fontSize="xs" color={theme.text.muted}>
          Save this clip's look (caption style, music, sound effects, progress bar, fades, keywords, emoji, hook) to
          apply it to other clips in one click, here or with Edit all clips.
        </Text>
      )}
      <HStack gap={2}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" style={fieldStyle} aria-label="Template name" />
        <OutlinedActionButton
          h="32px"
          px={3}
          fontSize="xs"
          onClick={() => {
            const saved = templateFromEdit(name, edit);
            void saveTemplate(saved).then((list) => {
              setTemplates(list);
              setSelected(list.find((t) => t.name === saved.name)?.id ?? saved.id);
              setName("");
              setNote(`Saved “${saved.name}”: ${describeTemplate(saved)}.`);
            });
          }}
        >
          Save look
        </OutlinedActionButton>
      </HStack>
      {note ? (
        <Text fontSize="xs" color={theme.text.muted}>
          {note}
        </Text>
      ) : null}
    </Section>
  );
};
