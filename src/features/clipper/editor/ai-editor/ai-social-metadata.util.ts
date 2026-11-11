/** AI-written social metadata (title, descriptions, hashtags) for exported clips. */
import type { ClipperFormatResult } from "../../shared/state.util";
import type { ClipperExportSocialPatch } from "../../persistence/clipper-export-db-api.util";
import type { AiChoice } from "./ai-choice.util";
import { requestEdit } from "./ai-editor-providers.util";

const SYSTEM = `You write social media copy for short video clips (TikTok, YouTube Shorts, Instagram Reels).
Reply with JSON only, no prose:
{"title":"...","short_description":"...","description":"...","hashtags":["tag", "..."]}
- Write in the same language as the transcript.
- title: a scroll-stopping hook, under 70 characters, no hashtags, no clickbait that the clip doesn't pay off.
- short_description: one sentence, under 150 characters.
- description: 1-3 sentences on what the viewer gets from the clip.
- hashtags: 3-8 relevant tags without the # sign, mixing broad and specific.`;

export interface SocialMetadataDraft {
  title: string;
  shortDescription: string;
  description: string;
  hashtags: string;
}

export function buildSocialMetadataMessages(result: Pick<ClipperFormatResult, "transcriptPlain" | "transcriptTimestamped" | "label">) {
  const transcript = (result.transcriptTimestamped || result.transcriptPlain || "").trim();
  return [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: `Platform format: ${result.label}\n\nClip transcript:\n${transcript}` },
  ];
}

export function parseSocialMetadata(reply: string): SocialMetadataDraft {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return metadata.");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("The AI's metadata couldn't be read.");
  }
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string).trim() : "");
  const rawTags = Array.isArray(value.hashtags) ? value.hashtags : typeof value.hashtags === "string" ? value.hashtags.split(/[\s,]+/) : [];
  const hashtags = [...new Set(rawTags.map((tag) => String(tag).replace(/^#+/, "").replace(/\s+/g, "").trim()).filter(Boolean))]
    .slice(0, 8)
    .map((tag) => `#${tag}`)
    .join(" ");
  const title = text("title");
  if (!title) throw new Error("The AI's metadata had no title.");
  return {
    title: title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title,
    shortDescription: text("short_description"),
    description: text("description"),
    hashtags,
  };
}

/** Patch for an export: everything when overwriting, otherwise only the empty fields. */
export function socialPatchFor(result: ClipperFormatResult, draft: SocialMetadataDraft, overwrite: boolean): ClipperExportSocialPatch {
  const pick = (current: string | undefined, next: string) => (overwrite || !current?.trim() ? next || undefined : undefined);
  const patch: ClipperExportSocialPatch = {
    socialTitle: pick(result.socialTitle, draft.title),
    socialShortDescription: pick(result.socialShortDescription, draft.shortDescription),
    socialDescription: pick(result.socialDescription, draft.description),
    socialHashtags: pick(result.socialHashtags, draft.hashtags),
  };
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as ClipperExportSocialPatch;
}

export function needsSocialMetadata(result: ClipperFormatResult): boolean {
  return [result.socialTitle, result.socialDescription, result.socialHashtags].some((field) => !field?.trim());
}

export async function writeSocialMetadata(choice: AiChoice, result: ClipperFormatResult): Promise<SocialMetadataDraft> {
  if (!result.transcriptPlain?.trim() && !result.transcriptTimestamped?.trim()) {
    throw new Error("This export has no transcript to write from.");
  }
  return parseSocialMetadata(await requestEdit(choice.provider, choice.model, buildSocialMetadataMessages(result)));
}
