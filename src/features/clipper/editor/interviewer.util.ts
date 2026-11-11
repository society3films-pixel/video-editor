/**
 * Finds the interviewer's questions in a clip: sentences phrased as questions, said while the
 * person on camera isn't moving their mouth (the voice is off camera). They can be cut, or cut
 * and shown as a question card over the answer.
 */
import type { WordCue } from "../lib/media/transcription-export.util";
import { splitSentences } from "./hook.util";
import { createEditId, cutSourceRange, getOutputDuration, sourceToOutputTime, type ClipEdit, type ClipTextOverlay } from "./clip-edit.util";

export interface InterviewQuestion {
  from: number;
  to: number;
  start: number;
  end: number;
  text: string;
  /** "off-camera": the on-screen person wasn't talking; "question": only phrased as one. */
  evidence: "off-camera" | "question";
}

const QUESTION_START = /^(what|how|why|when|where|who|which|do|did|does|can|could|would|will|is|are|was|were|have|has|tell|talk)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return /\?["')\]]*$/.test(t) || QUESTION_START.test(t);
}

/**
 * Questions from the transcript. With mouth activity (clip-local samples of the on-screen face),
 * a question counts as the interviewer's when that face moves under half as much as it does
 * while talking; without it, question wording alone (marked as "question").
 */
export function findInterviewQuestions(
  words: readonly WordCue[],
  activity: ReadonlyArray<{ t: number; activity: number }> | null,
): InterviewQuestion[] {
  const sentences = splitSentences(words);
  const levelIn = (start: number, end: number) => {
    const inside = activity?.filter((a) => a.t >= start && a.t <= end) ?? [];
    return inside.length ? inside.reduce((s, a) => s + a.activity, 0) / inside.length : null;
  };
  // Typical mouth movement while words are being said.
  const talking = activity?.length
    ? sentences.map((s) => levelIn(s.start, s.end)).filter((v): v is number => v !== null).sort((a, b) => a - b)
    : [];
  const typical = talking.length ? talking[Math.floor(talking.length * 0.6)]! : null;
  const questions: InterviewQuestion[] = [];
  for (const sentence of sentences) {
    const level = levelIn(sentence.start, sentence.end);
    const offCamera = typical !== null && level !== null && level < typical * 0.5;
    if (!looksLikeQuestion(sentence.text) && !(offCamera && sentence.end - sentence.start < 8 && /\?$/.test(sentence.text))) continue;
    if (typical !== null && level !== null && !offCamera) continue; // the on-screen person asked it (e.g. "you know what I mean?")
    questions.push({ ...sentence, evidence: offCamera ? "off-camera" : "question" });
  }
  return questions;
}

/** Cuts the questions; with cards, shows each one as on-screen text over the start of its answer. */
export function removeQuestions(edit: ClipEdit, questions: readonly InterviewQuestion[], asCards: boolean): ClipEdit {
  let next = edit;
  for (const q of questions) next = cutSourceRange(next, Math.max(0, q.start - 0.1), q.end + 0.15);
  if (!asCards) return next;
  const outputDuration = getOutputDuration(next.segments);
  const cards: ClipTextOverlay[] = questions.map((q) => {
    const start = Math.min(outputDuration - 0.5, Math.max(0, sourceToOutputTime(next.segments, q.end + 0.2)));
    const text = q.text.trim().replace(/^(so|and|but|um|uh)[, ]+/i, "");
    return {
      id: createEditId("question"),
      text: text.charAt(0).toUpperCase() + text.slice(1),
      start,
      end: Math.min(outputDuration, start + 2.8),
      position: "top",
      size: 0.045,
      color: "#FFFFFF",
      background: true,
    };
  });
  return { ...next, textOverlays: [...next.textOverlays.filter((o) => !o.id.startsWith("question-")), ...cards] };
}
