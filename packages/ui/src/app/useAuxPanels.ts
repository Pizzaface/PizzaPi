import * as React from "react";
import type { PanelPosition } from "@/hooks/usePanelLayout";
import type { ArtifactViewerTarget } from "./types";

/**
 * Open/position state for the two App-owned dock panels that aren't part of
 * usePanelLayout: the context & cache analyzer and the single-artifact viewer.
 */
export function useAuxPanels() {
  const [showAnalyzer, setShowAnalyzer] = React.useState(false);
  const [analyzerPosition, setAnalyzerPosition] = React.useState<PanelPosition>("center-bottom");
  const handleAnalyzerPositionChange = React.useCallback((pos: PanelPosition) => {
    setAnalyzerPosition(pos);
  }, []);

  // Single-artifact side viewer (Claude-style): one artifact at a time, not a list.
  const [artifactViewer, setArtifactViewer] = React.useState<ArtifactViewerTarget>(null);
  const [artifactViewerPosition, setArtifactViewerPosition] = React.useState<PanelPosition>("right-middle");
  const handleArtifactViewerPositionChange = React.useCallback((pos: PanelPosition) => {
    setArtifactViewerPosition(pos);
  }, []);

  return {
    showAnalyzer,
    setShowAnalyzer,
    analyzerPosition,
    handleAnalyzerPositionChange,
    artifactViewer,
    setArtifactViewer,
    artifactViewerPosition,
    handleArtifactViewerPositionChange,
  };
}

export type AuxPanels = ReturnType<typeof useAuxPanels>;
