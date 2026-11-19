import { Text, VStack } from "@chakra-ui/react";
import { useTheme } from "../../../theme";
import { SecondaryMainTitle } from "../../../shared/fonts/secondary-main-title.font";
import { TranscriptionSection } from "./settings/transcription-section.component";
import { FillMetadataAgentPromptSection } from "./settings/fill-metadata-agent-prompt-section.component";
import { AppUpdateCard } from "../../settings/app-update-card.component";
import { DeleteAccountSection } from "../../settings/delete-account-section.component";

export function ClipperHomeSettingsView() {
  const { theme } = useTheme();

  return (
    <VStack align="stretch" gap={10}>
      <VStack align="start" gap={2} maxW="720px">
        <SecondaryMainTitle
          fontSize={{ base: "2xl", md: "3xl" }}
          fontWeight="semibold"
          letterSpacing="-0.03em"
        >
          Settings
        </SecondaryMainTitle>
        <Text color={theme.text.muted} fontSize="md" lineHeight="1.6" maxW="36em">
          App updates, and the speech-to-text used for captions (on this computer, or a cloud service with your own key). Settings stay on this computer.
        </Text>
      </VStack>

      <AppUpdateCard />
      <TranscriptionSection variant="flat" />
      <FillMetadataAgentPromptSection />
      <DeleteAccountSection />
    </VStack>
  );
}
