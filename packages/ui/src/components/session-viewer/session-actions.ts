import * as React from "react";
import type { SessionActions } from "./session-actions-context";
import type { McpToggleHandler } from "./McpToggleContext";

export type { SessionActions };

export interface SessionActionsSetupResult {
  /** Value to pass to <SessionActionsProvider>. Null when onExec is unavailable. */
  sessionActions: SessionActions | null;
  /** MCP toggle handler wired to onExec — null when onExec is unavailable. */
  handleMcpToggle: McpToggleHandler | null;
}

/**
 * Builds the session-level action objects that are injected into the context tree.
 *
 * - `sessionActions` — passed to <SessionActionsProvider> so deeply nested tool
 *   cards can call abort() without prop drilling.
 * - `handleMcpToggle` — passed to <McpToggleContext.Provider> so MCP cards can
 *   enable/disable servers without prop drilling.
 */
export function useSessionActionsSetup(
  onExec: ((payload: unknown) => boolean | void) | undefined,
): SessionActionsSetupResult {
  const handleMcpToggle = React.useCallback<McpToggleHandler>(
    (serverName, disabled) => {
      if (!onExec) return;
      onExec({
        type: "exec",
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: "mcp_toggle_server",
        serverName,
        disabled,
      });
    },
    [onExec],
  );

  const sessionActions = React.useMemo<SessionActions | null>(() => {
    if (!onExec) return null;
    return {
      abort: () => {
        onExec({
          type: "exec",
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          command: "abort",
        });
      },
    };
  }, [onExec]);

  return {
    sessionActions,
    handleMcpToggle: onExec ? handleMcpToggle : null,
  };
}
