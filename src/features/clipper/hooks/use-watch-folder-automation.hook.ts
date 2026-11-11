/**
 * Drives a project created by the watch folder through the pipeline with no clicks: attach the
 * video, use the whole video as the range, wait for transcription and clips, render, then go back
 * to the home page so the next file can start.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { pathBackedFile } from "../platform/native-source.util";
import { loadJob, logEntry, saveJob, videoMimeType } from "../persistence/watch-folder.util";
import type { useClipperSessionView } from "./use-clipper-session-view.hook";

type SessionView = ReturnType<typeof useClipperSessionView>;

export function useWatchFolderAutomation(projectId: string, session: SessionView): void {
  const navigate = useNavigate();
  const stepRef = useRef<"attach" | "range" | "render" | "finish" | null>(null);
  const { state, visibility, handleFile, confirmRange, rangeLocked, sourceUrl, renderQueue, isRendering } = session;

  useEffect(() => {
    const job = loadJob();
    if (!job || job.projectId !== projectId) return;
    const finish = (status: "done" | "failed", detail?: string) => {
      if (stepRef.current === "finish") return;
      stepRef.current = "finish";
      saveJob(null);
      logEntry({ name: job.name, projectId, status, at: Date.now(), detail });
      setTimeout(() => navigate("/clipper"), 3000);
    };
    if (state.stage === "error") {
      finish("failed", state.error ?? "The pipeline stopped with an error");
      return;
    }
    if (visibility.showUpload && stepRef.current === null) {
      stepRef.current = "attach";
      void handleFile(pathBackedFile(job.path, job.name, videoMimeType(job.name)));
      return;
    }
    if (state.stage === "trimming" && sourceUrl && !rangeLocked && state.sourceDuration && stepRef.current !== "range") {
      stepRef.current = "range";
      void confirmRange(0, state.sourceDuration);
      return;
    }
    if (state.stage === "preview" && state.clipPreviews.length > 0 && !isRendering) {
      if (!job.autoRender) {
        finish("done", `${state.clipPreviews.length} clips ready to review`);
        return;
      }
      if (stepRef.current !== "render") {
        stepRef.current = "render";
        renderQueue.startQueuedRender({ skipExisting: true });
      }
      return;
    }
    if (state.stage === "done" && !isRendering && stepRef.current === "render") {
      finish("done", `${state.clipPreviews.length} clips rendered`);
    }
  }, [confirmRange, handleFile, isRendering, navigate, projectId, rangeLocked, renderQueue, sourceUrl, state, visibility.showUpload]);
}
