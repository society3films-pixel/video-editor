/** An AI's read of how well a clip will do: hook, pacing, payoff, and the one fix that matters most. */
import { localRecordGet, localRecordPut } from "../../../../shared/persistence/local-database.util";
import type { ClipperFormatResult } from "../../shared/state.util";
import type { AiChoice } from "./ai-choice.util";
import { requestEdit } from "./ai-editor-providers.util";

export interface ViralityScore {
  /** 1-10 overall. */
  score: number;
  hook: number;
  pacing: number;
  payoff: number;
  tip: string;
  scoredAt: string;
  model: string;
}

const SYSTEM = `You judge short social videos (TikTok, Reels, Shorts) from their transcript, like an experienced editor.
Score 1-10: hook (do the first 3 seconds make people stay?), pacing (no dead air, rambling or repetition), payoff (does it deliver what the start promises, with a satisfying ending?), and overall (how likely it is to perform). Be honest and spread your scores; most clips are 4-7.
Give one concrete tip: the single change that would help most (quote the words to cut or move if relevant).
Reply with JSON only: {"overall": n, "hook": n, "pacing": n, "payoff": n, "tip": "..."}`;

export function parseViralityReply(reply: string, model: string): ViralityScore {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return a score.");
  const value = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  const n = (key: string) => {
    const v = Number(value[key]);
    if (!Number.isFinite(v)) throw new Error("The AI's score was incomplete.");
    return Math.min(10, Math.max(1, Math.round(v)));
  };
  return {
    score: n("overall"),
    hook: n("hook"),
    pacing: n("pacing"),
    payoff: n("payoff"),
    tip: String(value.tip ?? "").trim(),
    scoredAt: new Date().toISOString(),
    model,
  };
}

export async function scoreExport(choice: AiChoice, result: ClipperFormatResult): Promise<ViralityScore> {
  const transcript = (result.transcriptTimestamped || result.transcriptPlain || "").trim();
  if (!transcript) throw new Error("This export has no transcript to judge.");
  const reply = await requestEdit(choice.provider, choice.model, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Title: ${result.socialTitle || "(none)"}\nFormat: ${result.label}\n\nTranscript:\n${transcript}` },
  ]);
  const score = parseViralityReply(reply, choice.model);
  await localRecordPut("clipper-export-scores", result.id, null, score);
  return score;
}

export async function loadScores(exportIds: readonly string[]): Promise<Map<string, ViralityScore>> {
  const entries = await Promise.all(
    exportIds.map(async (id) => [id, await localRecordGet<ViralityScore>("clipper-export-scores", id).catch(() => null)] as const),
  );
  return new Map(entries.filter((entry): entry is readonly [string, ViralityScore] => Boolean(entry[1])));
}
