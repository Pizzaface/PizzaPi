import * as React from "react";
import type { ResolvedModeUi } from "@pizzapi/protocol";

/**
 * Context carrying the active session's resolved mode UI to the message tree.
 *
 * Same reasoning as McpToggleContext: renderContent() and its callers pass
 * positional arguments, and threading a mode object through every layer to
 * reach the tool cards would touch every call site. Null means "no mode",
 * which every consumer must read as the standard coding UI.
 */
export const ModeUiContext = React.createContext<ResolvedModeUi | null>(null);

export function useModeUi(): ResolvedModeUi | null {
  return React.useContext(ModeUiContext);
}

/** What an artifact card needs from the host to fetch and open a file. */
export interface ArtifactHost {
  /** Runner that owns the session's filesystem. */
  runnerId?: string;
  /** Open a path in the file explorer, when the host offers one. */
  onOpenFile?: (path: string) => void;
}

export const ArtifactHostContext = React.createContext<ArtifactHost | null>(null);

export function useArtifactHost(): ArtifactHost | null {
  return React.useContext(ArtifactHostContext);
}
