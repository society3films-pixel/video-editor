import React from "react";
import { VStack } from "@chakra-ui/react";
import type { ClipperFormatResult } from "../shared/state.util";
import type { ClipEditorSource } from "../editor/clip-editor-source.util";
import { ClipperExportFormatRow } from "./clipper-export-format-row.component";

interface ClipperExportHistoryListProps {
  exports: ClipperFormatResult[];
  projectId: string;
  onExportEdited?: () => void;
  getClipEditorSource?: (result: ClipperFormatResult) => ClipEditorSource | null;
}

export const ClipperExportHistoryList: React.FC<ClipperExportHistoryListProps> = ({
  exports,
  projectId,
  onExportEdited,
  getClipEditorSource,
}) => {
  return (
    <VStack align="stretch" gap={2}>
      {exports.map((result) => (
        <ClipperExportFormatRow
          key={result.id}
          result={result}
          projectId={projectId}
          onEdited={onExportEdited}
          getClipEditorSource={getClipEditorSource}
        />
      ))}
    </VStack>
  );
};
