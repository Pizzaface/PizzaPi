import { createContext, useContext } from "react";

export interface SessionActions {
  /** Send an abort exec command to kill the current agent turn (and any running bash commands). */
  abort: () => void;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

export const SessionActionsProvider = SessionActionsContext.Provider;

/**
 * Access session-level actions (e.g. abort) from deeply nested components
 * like tool cards. Returns null when no provider is mounted (e.g. in tests
 * or snapshot-only views).
 */
export function useSessionActions(): SessionActions | null {
  return useContext(SessionActionsContext);
}
