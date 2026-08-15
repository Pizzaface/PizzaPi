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
