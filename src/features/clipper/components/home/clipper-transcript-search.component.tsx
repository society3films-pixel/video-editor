import React, { useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { OutlinedActionButton } from "../../../../shared/components/buttons/outlined-action-button.component";
import { useClipperUi } from "../../shared/use-clipper-ui.hook";
import { appToast } from "../../../../shared/utils/toast.service";
import { makeClipFromMatch, searchAllTranscripts, type TranscriptMatch } from "../../persistence/transcript-search.util";

function time(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Search every project's transcript; make a clip from any hit. */
export const ClipperTranscriptSearch: React.FC = () => {
  const { theme } = useClipperUi();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<TranscriptMatch[] | null>(null);
  const [made, setMade] = useState<Set<string>>(new Set());

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await searchAllTranscripts(query.trim()));
    } catch (error) {
      appToast.error("Search failed", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const byProject = new Map<string, TranscriptMatch[]>();
  for (const match of results ?? []) byProject.set(match.projectId, [...(byProject.get(match.projectId) ?? []), match]);

  return (
    <VStack align="stretch" gap={3} p={4} borderRadius="xl" border="1px solid" borderColor={theme.surface.hover} bg={theme.background.card}>
      <HStack gap={2}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          placeholder="Search what was said in every project, e.g. pricing, first customer"
          aria-label="Search transcripts"
          style={{
            flex: 1,
            background: "rgba(0,0,0,0.35)",
            color: "inherit",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 14,
          }}
        />
        <OutlinedActionButton startIcon={busy ? <Spinner size="xs" /> : <Search size={16} />} onClick={() => void run()} disabled={busy || !query.trim()}>
          Search
        </OutlinedActionButton>
      </HStack>
      {results ? (
        results.length === 0 ? (
          <Text fontSize="sm" color={theme.text.muted}>
            Not found in any transcript.
          </Text>
        ) : (
          <VStack align="stretch" gap={3} maxH="420px" overflowY="auto">
            <Text fontSize="xs" color={theme.text.muted}>
              {results.length} match{results.length === 1 ? "" : "es"} in {byProject.size} project{byProject.size === 1 ? "" : "s"}. Make clip saves about 30 seconds around it as an AI clip of that project.
            </Text>
            {[...byProject.entries()].map(([projectId, matches]) => (
              <VStack key={projectId} align="stretch" gap={1}>
                <HStack justify="space-between">
                  <Text fontSize="sm" fontWeight="semibold">
                    {matches[0]!.projectName}
                  </Text>
                  <Box as="button" fontSize="xs" color={theme.text.muted} cursor="pointer" onClick={() => navigate(`/clipper/${projectId}`)}>
                    Open project
                  </Box>
                </HStack>
                {matches.map((match) => {
                  const key = `${projectId}:${match.wordIndex}`;
                  return (
                    <HStack key={key} gap={3} p={2} borderRadius="md" bg="rgba(0,0,0,0.2)" align="start">
                      <Text fontSize="xs" fontFamily="mono" color={theme.text.muted} minW="40px">
                        {time(match.time)}
                      </Text>
                      <Text fontSize="xs" flex={1}>
                        …{match.before} <b>{match.match}</b> {match.after}…
                      </Text>
                      <OutlinedActionButton
                        h="26px"
                        px={2}
                        fontSize="xs"
                        disabled={made.has(key)}
                        onClick={() =>
                          void makeClipFromMatch(match)
                            .then(() => {
                              setMade((current) => new Set(current).add(key));
                              appToast.success("Clip added", `Saved to ${match.projectName}'s AI clips (Preview → AI).`);
                            })
                            .catch((error: unknown) => appToast.error("Could not make the clip", error instanceof Error ? error.message : String(error)))
                        }
                      >
                        {made.has(key) ? "Added" : "Make clip"}
                      </OutlinedActionButton>
                    </HStack>
                  );
                })}
              </VStack>
            ))}
          </VStack>
        )
      ) : null}
    </VStack>
  );
};
